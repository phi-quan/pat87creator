import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';
import { buildBillingReconciliationReport } from '../reconcile/_lib/reconciliation';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type JobRow = {
  status: JobStatus;
  attempt_count: number;
  billed_credits: number;
  created_at: string;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  execution_duration_ms: number | null;
  revenue_usd: number | null;
};

type JobCostRow = {
  amount_usd: number;
  created_at: string;
};

type HealthResponse = {
  status?: string;
  db?: boolean;
  queue?: boolean;
  stripe?: boolean;
};

const MAX_DEAD_LETTER_ATTEMPTS = 3;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const safeIndex = Math.max(0, Math.min(sorted.length - 1, index));

  return Math.round(sorted[safeIndex]);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

async function fetchSystemHealth(adminSecret: string, request: Request): Promise<{ db: boolean; queue: boolean; stripe: boolean }> {
  const configuredBaseUrl = process.env.WORKER_API_BASE_URL;

  if (!configuredBaseUrl) {
    return {
      db: true,
      queue: Boolean(process.env.CLOUDFLARE_QUEUE),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET)
    };
  }

  try {
    const url = new URL('/api/health', configuredBaseUrl);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-admin-secret': adminSecret,
        'x-forwarded-host': request.headers.get('host') ?? ''
      },
      cache: 'no-store'
    });

    if (!response.ok) {
      return { db: false, queue: false, stripe: false };
    }

    const payload = (await response.json()) as HealthResponse;

    return {
      db: toBoolean(payload.db),
      queue: toBoolean(payload.queue),
      stripe: toBoolean(payload.stripe)
    };
  } catch {
    return { db: false, queue: false, stripe: false };
  }
}

export const GET = withSafeApiHandler('/api/admin/monitoring', async (request: Request) => {
  const adminSecret = getRequiredEnv('ADMIN_SECRET');
  const incomingSecret = request.headers.get('x-admin-secret');

  if (!incomingSecret || incomingSecret !== adminSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = Date.now();
  const hourAgoIso = new Date(now - ONE_HOUR_MS).toISOString();
  const dayAgoIso = new Date(now - ONE_DAY_MS).toISOString();
  const todayStartIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const jobsQuery = client
    .from('jobs')
    .select(
      'status, attempt_count, billed_credits, created_at, processing_started_at, processing_completed_at, execution_duration_ms, revenue_usd'
    )
    .gte('created_at', dayAgoIso);

  const jobCostsQuery = client.from('job_costs').select('amount_usd, created_at').gte('created_at', todayStartIso);

  const [jobsResult, costsResult, health] = await Promise.all([
    jobsQuery.returns<JobRow[]>(),
    jobCostsQuery.returns<JobCostRow[]>(),
    fetchSystemHealth(adminSecret, request)
  ]);

  const billingIntegrity = await buildBillingReconciliationReport();

  if (jobsResult.error) {
    return Response.json({ error: 'internal_server_error' }, { status: 500 });
  }

  if (costsResult.error) {
    return Response.json({ error: 'internal_server_error' }, { status: 500 });
  }

  const jobs = jobsResult.data ?? [];
  const costs = costsResult.data ?? [];

  const hourJobs = jobs.filter((job) => new Date(job.created_at).getTime() >= now - ONE_HOUR_MS);
  const dayJobs = jobs;

  const completedDurations = jobs
    .map((job) => job.execution_duration_ms ?? null)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  const creditsConsumedLastHour = sum(hourJobs.map((job) => job.billed_credits ?? 0));
  const revenueLastHour = sum(hourJobs.map((job) => job.revenue_usd ?? 0));

  const hourCostRows = costs.filter((cost) => new Date(cost.created_at).getTime() >= now - ONE_HOUR_MS);
  const costLastHour = sum(hourCostRows.map((cost) => cost.amount_usd ?? 0));

  const todayCostRows = costs.filter((cost) => new Date(cost.created_at).getTime() >= new Date(todayStartIso).getTime());
  const costToday = sum(todayCostRows.map((cost) => cost.amount_usd ?? 0));

  const todayJobs = jobs.filter((job) => new Date(job.created_at).getTime() >= new Date(todayStartIso).getTime());
  const revenueToday = sum(todayJobs.map((job) => job.revenue_usd ?? 0));

  const completedHour = hourJobs.filter((job) => job.status === 'completed').length;
  const completedDay = dayJobs.filter((job) => job.status === 'completed').length;

  const successRateHour = hourJobs.length > 0 ? completedHour / hourJobs.length : 0;
  const successRateDay = dayJobs.length > 0 ? completedDay / dayJobs.length : 0;

  const activeJobs = jobs.filter((job) => job.status === 'processing').length;
  const queuedJobs = jobs.filter((job) => job.status === 'queued').length;
  const failedJobs = jobs.filter((job) => job.status === 'failed').length;
  const deadLetterJobs = jobs.filter(
    (job) => job.status === 'failed' && (job.attempt_count ?? 0) >= MAX_DEAD_LETTER_ATTEMPTS
  ).length;

  return Response.json({
    jobs_last_hour: hourJobs.length,
    jobs_last_24_hours: dayJobs.length,
    jobs_success_rate: Number(successRateHour.toFixed(4)),
    jobs_success_rate_24h: Number(successRateDay.toFixed(4)),
    jobs_failed: failedJobs,
    dead_letter_count: deadLetterJobs,
    avg_processing_time_ms: completedDurations.length > 0 ? Math.round(sum(completedDurations) / completedDurations.length) : 0,
    p95_processing_time_ms: percentile(completedDurations, 95),
    active_jobs: activeJobs,
    queue_depth: queuedJobs + activeJobs,
    jobs_processing: activeJobs,
    jobs_queued: queuedJobs,
    jobs_dead_letter: deadLetterJobs,
    credits_consumed_last_hour: creditsConsumedLastHour,
    revenue_last_hour_usd: Number(revenueLastHour.toFixed(2)),
    cost_last_hour_usd: Number(costLastHour.toFixed(2)),
    margin_last_hour_usd: Number((revenueLastHour - costLastHour).toFixed(2)),
    revenue_today_usd: Number(revenueToday.toFixed(2)),
    cost_today_usd: Number(costToday.toFixed(2)),
    margin_today_usd: Number((revenueToday - costToday).toFixed(2)),
    billing_integrity: {
      payments_verified: billingIntegrity.payments_checked,
      credit_mismatches: billingIntegrity.credit_mismatches,
      revenue_mismatch: billingIntegrity.revenue_mismatch,
      anomaly_count: billingIntegrity.anomalies.length,
      negative_margin_jobs: billingIntegrity.negative_margin_jobs,
      credits_verified: billingIntegrity.credits_verified,
      last_reconciled_at: billingIntegrity.generated_at
    },
    system_health: health,
    refreshed_at: new Date().toISOString()
  });
});
