import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { log } from '@pat87creator/logger';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type Env = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ADMIN_SECRET?: string;
  VIDEO_JOB_QUEUE?: Queue;
};

type JsonRecord = Record<string, unknown>;

type AdminJobRow = {
  id: string;
  user_id: string;
  status: JobStatus;
  attempt_count: number;
  execution_duration_ms: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type MetricsRow = {
  total_jobs: number;
  completed: number;
  failed: number;
  processing: number;
  queued: number;
  avg_execution_ms: number;
  retry_rate: number;
  total_cost_usd: number;
  total_revenue_usd: number;
  total_margin_usd: number;
  avg_margin_per_job: number;
};

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function json(data: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStatus(value: string | null): JobStatus | null {
  if (!value) {
    return null;
  }

  if (value === 'queued' || value === 'processing' || value === 'completed' || value === 'failed') {
    return value;
  }

  return null;
}

function createServiceClient(env: Env) {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function authorizeAdmin(request: Request, env: Env): Response | null {
  const secret = env.ADMIN_SECRET;
  const received = request.headers.get('x-admin-secret');

  if (!secret || !received || received !== secret) {
    log('warn', 'Unauthorized admin access attempt', {
      route: new URL(request.url).pathname
    });
    return json({ error: 'Unauthorized' }, 401);
  }

  return null;
}

async function handleAdminJobs(request: Request, env: Env): Promise<Response> {
  const unauthorized = authorizeAdmin(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const page = parsePositiveInt(url.searchParams.get('page'), DEFAULT_PAGE);
  const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
  const minAttempts = parsePositiveInt(url.searchParams.get('min_attempts'), 0);
  const status = parseStatus(url.searchParams.get('status'));

  if (url.searchParams.get('status') && !status) {
    return json({ error: 'Invalid status filter' }, 400);
  }

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const client = createServiceClient(env);
  let query = client
    .from('jobs')
    .select(
      'id, user_id, status, attempt_count, execution_duration_ms, error_message, created_at, updated_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) {
    query = query.eq('status', status);
  }

  if (minAttempts > 0) {
    query = query.gte('attempt_count', minAttempts);
  }

  const { data, count, error } = await query.returns<AdminJobRow[]>();

  if (error) {
    log('error', 'Failed to fetch admin jobs', { route: '/api/admin/jobs', error: error.message });
    return json({ error: 'internal_server_error' }, 500);
  }

  return json({ total: count ?? 0, page, limit, data: data ?? [] });
}

async function handleAdminMetrics(request: Request, env: Env): Promise<Response> {
  const unauthorized = authorizeAdmin(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  const client = createServiceClient(env);
  const { data, error } = await client.from('admin_job_metrics').select('*').single<MetricsRow>();

  if (error) {
    log('error', 'Failed to fetch admin metrics', { route: '/api/admin/metrics', error: error.message });
    return json({ error: 'internal_server_error' }, 500);
  }

  return json({
    total_jobs: data?.total_jobs ?? 0,
    completed: data?.completed ?? 0,
    failed: data?.failed ?? 0,
    processing: data?.processing ?? 0,
    queued: data?.queued ?? 0,
    avg_execution_ms: data?.avg_execution_ms ?? 0,
    retry_rate: data?.retry_rate ?? 0,
    total_cost_usd: data?.total_cost_usd ?? 0,
    total_revenue_usd: data?.total_revenue_usd ?? 0,
    total_margin_usd: data?.total_margin_usd ?? 0,
    avg_margin_per_job: data?.avg_margin_per_job ?? 0
  });
}

async function handleHealth(env: Env): Promise<Response> {
  const db = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  const queue = Boolean(env.VIDEO_JOB_QUEUE);
  const stripe = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

  if (!db || !queue || !stripe || !env.ADMIN_SECRET) {
    return json({ status: 'error', db, queue, stripe }, 500);
  }

  const client = createServiceClient(env);
  const { error } = await client.from('jobs').select('id').limit(1);

  if (error) {
    log('error', 'Health check database query failed', { route: '/api/health', error: error.message });
    return json({ status: 'error', db: false, queue, stripe }, 500);
  }

  return json({ status: 'ok', db: true, queue: true, stripe: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);

      if (request.method === 'GET' && pathname === '/api/admin/jobs') {
        return await handleAdminJobs(request, env);
      }

      if (request.method === 'GET' && pathname === '/api/admin/metrics') {
        return await handleAdminMetrics(request, env);
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        return await handleHealth(env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      log('error', 'Unhandled worker-api error', {
        route: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : 'unknown_error'
      });
      return json({ error: 'internal_server_error' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
