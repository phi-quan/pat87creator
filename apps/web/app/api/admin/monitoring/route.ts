export const runtime = 'edge';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';
import { buildBillingReconciliationReport } from '../reconcile/_lib/reconciliation';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type JobRevenueRow = {
  billed_credits: number;
  revenue_usd: number | null;
};

type JobDurationRow = {
  execution_duration_ms: number | null;
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
const MONITORING_CACHE_TTL_MS = 5_000;
const DEFAULT_QUEUE_BACKLOG_THRESHOLD = 20;
const DEFAULT_WORKER_CONCURRENCY = 5;

const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

let cachedResponse: { expiresAt: number; payload: Record<string, unknown> } | null = null;

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

function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function countJobs(
  client: SupabaseClient<any, any, any>,
  filters: { status?: JobStatus; since?: string; deadLetter?: boolean }
): Promise<number> {
  let query = client.from('jobs').select('id', { count: 'exact', head: true });

  if (filters.status) {
    query = query.eq('status', filters.status);
  }

  if (filters.since) {
    query = query.gte('created_at', filters.since);
  }

  if (filters.deadLetter) {
    query = query.eq('status', 'failed').gte('attempt_count', MAX_DEAD_LETTER_ATTEMPTS);
  }

  const { count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

export const GET = withSafeApiHandler('/api/admin/monitoring', async (request: Request) => {
  const adminSecret = getRequiredEnv('ADMIN_SECRET');
  const incomingSecret = request.headers.get('x-admin-secret');

  if (!incomingSecret || incomingSecret !== adminSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (cachedResponse && Date.now() < cachedResponse.expiresAt) {
    return Response.json(cachedResponse.payload);
  }

  const now = Date.now();
  const hourAgoIso = new Date(now - ONE_HOUR_MS).toISOString();
  const dayAgoIso = new Date(now - ONE_DAY_MS).toISOString();
  const todayStartIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const workerConcurrency = getEnvNumber('WORKER_CONCURRENCY', DEFAULT_WORKER_CONCURRENCY);
  const queueBacklogThreshold = getEnvNumber('QUEUE_BACKLOG_THRESHOLD', DEFAULT_QUEUE_BACKLOG_THRESHOLD);

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const [
    jobsLastHour,
    jobsLast24Hours,
    completedHour,
    completedDay,
    queuedJobs,
    activeJobs,
    failedJobs,
    deadLetterJobs,
    hourRevenueRowsResult,
    dayDurationRowsResult,
    costsTodayResult,
    health,
    billingIntegrity
  ] = await Promise.all([
    countJobs(client, { since: hourAgoIso }),
    countJobs(client, { since: dayAgoIso }),
    countJobs(client, { status: 'completed', since: hourAgoIso }),
    countJobs(client, { status: 'completed', since: dayAgoIso }),
    countJobs(client, { status: 'queued' }),
    countJobs(client, { status: 'processing' }),
    countJobs(client, { status: 'failed', since: dayAgoIso }),
    countJobs(client, { deadLetter: true }),
    client.from('jobs').select('billed_credits, revenue_usd').gte('created_at', hourAgoIso).returns<JobRevenueRow[]>(),
    client
      .from('jobs')
      .select('execution_duration_ms')
      .eq('status', 'completed')
      .gte('created_at', dayAgoIso)
      .returns<JobDurationRow[]>(),
    client.from('job_costs').select('amount_usd, created_at').gte('created_at', todayStartIso).returns<JobCostRow[]>(),
    fetchSystemHealth(adminSecret, request),
    buildBillingReconciliationReport({ since: dayAgoIso })
  ]);

  if (hourRevenueRowsResult.error || dayDurationRowsResult.error || costsTodayResult.error) {
    return Response.json({ error: 'internal_server_error' }, { status: 500 });
  }

  const hourRevenueRows = hourRevenueRowsResult.data ?? [];
  const dayDurationRows = dayDurationRowsResult.data ?? [];
  const costsToday = costsTodayResult.data ?? [];

  const completedDurations = dayDurationRows
    .map((job) => job.execution_duration_ms ?? null)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  const creditsConsumedLastHour = sum(hourRevenueRows.map((job) => job.billed_credits ?? 0));
  const revenueLastHour = sum(hourRevenueRows.map((job) => job.revenue_usd ?? 0));

  const nowMs = now;
  const costLastHour = sum(
    costsToday
      .filter((cost) => new Date(cost.created_at).getTime() >= nowMs - ONE_HOUR_MS)
      .map((cost) => Number(cost.amount_usd ?? 0))
  );
  const costToday = sum(costsToday.map((cost) => Number(cost.amount_usd ?? 0)));

  const successRateHour = jobsLastHour > 0 ? completedHour / jobsLastHour : 0;
  const successRateDay = jobsLast24Hours > 0 ? completedDay / jobsLast24Hours : 0;
  const queueDepth = queuedJobs + activeJobs;
  const queueBacklogSize = Math.max(queuedJobs - queueBacklogThreshold, 0);
  const jobsPerMinute = Number((jobsLastHour / 60).toFixed(2));
  const workerUtilization = Number(Math.min(1, activeJobs / workerConcurrency).toFixed(4));

  const payload: Record<string, unknown> = {
    jobs_last_hour: jobsLastHour,
    jobs_last_24_hours: jobsLast24Hours,
    jobs_per_minute: jobsPerMinute,
    jobs_success_rate: Number(successRateHour.toFixed(4)),
    jobs_success_rate_24h: Number(successRateDay.toFixed(4)),
    jobs_failed: failedJobs,
    dead_letter_count: deadLetterJobs,
    avg_processing_time_ms: completedDurations.length > 0 ? Math.round(sum(completedDurations) / completedDurations.length) : 0,
    p95_processing_time_ms: percentile(completedDurations, 95),
    active_jobs: activeJobs,
    queue_depth: queueDepth,
    queue_backlog_size: queueBacklogSize,
    queue_backlog_threshold: queueBacklogThreshold,
    jobs_processing: activeJobs,
    jobs_queued: queuedJobs,
    jobs_dead_letter: deadLetterJobs,
    worker_concurrency: workerConcurrency,
    worker_utilization: workerUtilization,
    credits_consumed_last_hour: creditsConsumedLastHour,
    revenue_last_hour_usd: Number(revenueLastHour.toFixed(2)),
    cost_last_hour_usd: Number(costLastHour.toFixed(2)),
    margin_last_hour_usd: Number((revenueLastHour - costLastHour).toFixed(2)),
    revenue_today_usd: Number(billingIntegrity.totals.jobs_revenue_usd.toFixed(2)),
    cost_today_usd: Number(costToday.toFixed(2)),
    margin_today_usd: Number((billingIntegrity.totals.jobs_revenue_usd - costToday).toFixed(2)),
    billing_integrity: {
      payments_verified: billingIntegrity.payments_checked,
      credit_mismatches: billingIntegrity.credit_mismatches,
      revenue_mismatch: billingIntegrity.revenue_mismatch,
      anomaly_count: billingIntegrity.anomalies.length,
      negative_margin_jobs: billingIntegrity.negative_margin_jobs,
      credits_verified: billingIntegrity.credits_verified,
      last_reconciled_at: billingIntegrity.generated_at,
      since: billingIntegrity.since
    },
    system_health: health,
    refreshed_at: new Date().toISOString()
  };

  cachedResponse = {
    expiresAt: Date.now() + MONITORING_CACHE_TTL_MS,
    payload
  };

  return Response.json(payload);
});
