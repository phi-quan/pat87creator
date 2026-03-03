import { createClient } from '@supabase/supabase-js';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type Env = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
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

function log(level: 'info' | 'warn' | 'error', message: string, context: JsonRecord = {}): void {
  const record = {
    level,
    message,
    ...context
  };

  const serialized = JSON.stringify(record);
  if (level === 'error') {
    console.error(serialized);
    return;
  }

  if (level === 'warn') {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
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
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase service configuration');
  }

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
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
      path: new URL(request.url).pathname
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
    log('error', 'Failed to fetch admin jobs', { error: error.message });
    return json({ error: 'Failed to fetch jobs' }, 500);
  }

  return json({
    total: count ?? 0,
    page,
    limit,
    data: data ?? []
  });
}

async function handleAdminMetrics(request: Request, env: Env): Promise<Response> {
  const unauthorized = authorizeAdmin(request, env);
  if (unauthorized) {
    return unauthorized;
  }

  const client = createServiceClient(env);
  const { data, error } = await client.from('admin_job_metrics').select('*').single<MetricsRow>();

  if (error) {
    log('error', 'Failed to fetch admin metrics', { error: error.message });
    return json({ error: 'Failed to fetch metrics' }, 500);
  }

  return json({
    total_jobs: data?.total_jobs ?? 0,
    completed: data?.completed ?? 0,
    failed: data?.failed ?? 0,
    processing: data?.processing ?? 0,
    queued: data?.queued ?? 0,
    avg_execution_ms: data?.avg_execution_ms ?? 0,
    retry_rate: data?.retry_rate ?? 0
  });
}

async function handleHealth(env: Env): Promise<Response> {
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.ADMIN_SECRET) {
    return json({ status: 'error', error: 'Missing required environment variables' }, 500);
  }

  if (!env.VIDEO_JOB_QUEUE) {
    return json({ status: 'error', error: 'Queue binding not configured' }, 500);
  }

  try {
    const client = createServiceClient(env);
    const { error } = await client.from('jobs').select('id').limit(1);

    if (error) {
      log('error', 'Health check database query failed', { error: error.message });
      return json({ status: 'error', error: 'Database unavailable' }, 500);
    }

    return json({ status: 'ok' });
  } catch (error) {
    log('error', 'Health check failed', {
      error: error instanceof Error ? error.message : 'Unknown health error'
    });
    return json({ status: 'error', error: 'Health check failure' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === 'GET' && pathname === '/api/admin/jobs') {
      return handleAdminJobs(request, env);
    }

    if (request.method === 'GET' && pathname === '/api/admin/metrics') {
      return handleAdminMetrics(request, env);
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      return handleHealth(env);
    }

    return json({ error: 'Not found' }, 404);
  }
} satisfies ExportedHandler<Env>;
