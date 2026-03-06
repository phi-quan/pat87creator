export const runtime = 'edge';
import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { log } from '@pat87creator/logger';
import { getVideoJobCost } from '../../../../lib/billing';
import { withSafeApiHandler } from '../../_lib/safeHandler';

type CreateJobRequest = {
  payload?: unknown;
};

type ParsedCreatePayload = {
  prompt: string;
  video_type: string;
};

type CreateJobRpcResponse = {
  data: string | null;
  error: { message: string } | null;
};

type RateLimitCode = 'jobs_per_minute' | 'concurrent_jobs' | 'daily_credits';

type RateLimitErrorResponse = {
  error: 'rate_limit_exceeded';
  code: RateLimitCode;
  message: string;
};

type JobQueueMessage = {
  job_id: string;
  user_id: string;
  prompt: string;
  video_type: string;
  created_at: string;
};

type QueueBinding = {
  send: (message: JobQueueMessage) => Promise<void>;
};

type RuntimeWithQueue = typeof globalThis & {
  VIDEO_JOB_QUEUE?: QueueBinding;
};

const VIDEO_JOB_COST = getVideoJobCost();
const RATE_LIMIT_PREFIX = 'RATE_LIMIT_EXCEEDED|';

const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = getRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const supabaseServiceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCreatePayload(payload: unknown): ParsedCreatePayload | null {
  if (!isJsonObject(payload) || typeof payload.prompt !== 'string') {
    return null;
  }

  const prompt = payload.prompt.trim();
  if (!prompt) {
    return null;
  }

  const videoType = typeof payload.video_type === 'string' && payload.video_type.trim() ? payload.video_type : 'short';

  return {
    prompt,
    video_type: videoType
  };
}

function getQueueBinding(): QueueBinding | null {
  const runtime = globalThis as RuntimeWithQueue;

  return runtime.VIDEO_JOB_QUEUE ?? null;
}

function enqueueJob(message: JobQueueMessage): void {
  const queue = getQueueBinding();

  if (!queue) {
    log('error', 'Queue binding unavailable', { route: '/api/jobs/create', job_id: message.job_id });
    return;
  }

  void queue.send(message).catch((error: unknown) => {
    log('error', 'Failed to enqueue video job', {
      route: '/api/jobs/create',
      job_id: message.job_id,
      user_id: message.user_id,
      error: error instanceof Error ? error.message : 'unknown_error'
    });
  });
}

async function publishJobToQueueApi(message: JobQueueMessage): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const queueId = process.env.CLOUDFLARE_QUEUE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !queueId || !apiToken) {
    log('warn', 'Cloudflare queue API credentials are missing; queue publish skipped', {
      route: '/api/jobs/create',
      job_id: message.job_id
    });
    return;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body: message })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloudflare queue publish failed: ${response.status} ${body}`);
  }
}

function parseRateLimitError(message: string | undefined): RateLimitErrorResponse | null {
  if (!message?.startsWith(RATE_LIMIT_PREFIX)) {
    return null;
  }

  const [, code, userMessage] = message.split('|');

  if (code !== 'jobs_per_minute' && code !== 'concurrent_jobs' && code !== 'daily_credits') {
    return null;
  }

  return {
    error: 'rate_limit_exceeded',
    code,
    message: userMessage ?? 'Rate limit exceeded'
  };
}

export const POST = withSafeApiHandler('/api/jobs/create', async (request: Request) => {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  const {
    data: { user },
    error: userError
  } = await authClient.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let requestBody: CreateJobRequest;

  try {
    requestBody = (await request.json()) as CreateJobRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsedPayload = parseCreatePayload(requestBody.payload);

  if (!parsedPayload) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { data: videoRow, error: videoError } = await serviceClient
    .from('videos')
    .insert({
      user_id: user.id,
      source_url: 'pending://render',
      status: 'queued'
    })
    .select('id')
    .single<{ id: string }>();

  if (videoError || !videoRow?.id) {
    log('error', 'Unable to create video row for job', {
      route: '/api/jobs/create',
      user_id: user.id,
      error: videoError?.message ?? 'unknown_error'
    });

    return Response.json({ error: 'Unable to create job' }, { status: 500 });
  }

  const requestTimestamp = new Date().toISOString();

  const rpcResponse = (await serviceClient.rpc('create_video_job', {
    p_user_id: user.id,
    p_cost: VIDEO_JOB_COST,
    p_payload: {
      video_id: videoRow.id,
      prompt: parsedPayload.prompt,
      video_type: parsedPayload.video_type,
      created_at: requestTimestamp
    }
  })) as CreateJobRpcResponse;

  if (rpcResponse.error || !rpcResponse.data) {
    log('warn', 'create_video_job RPC failed', {
      route: '/api/jobs/create',
      user_id: user.id,
      error: rpcResponse.error?.message ?? 'unknown_error'
    });

    const rateLimitError = parseRateLimitError(rpcResponse.error?.message);
    if (rateLimitError) {
      return Response.json(rateLimitError, { status: 429 });
    }

    const isInsufficientCredits =
      rpcResponse.error?.message?.toLowerCase().includes('insufficient credits') ?? false;

    if (isInsufficientCredits) {
      return Response.json({ error: 'Insufficient credits' }, { status: 402 });
    }

    return Response.json({ error: 'Unable to create job' }, { status: 400 });
  }

  const jobId = rpcResponse.data;
  const queueMessage: JobQueueMessage = {
    job_id: jobId,
    user_id: user.id,
    prompt: parsedPayload.prompt,
    video_type: parsedPayload.video_type,
    created_at: requestTimestamp
  };

  enqueueJob(queueMessage);
  void publishJobToQueueApi(queueMessage).catch((error: unknown) => {
    log('error', 'Failed to publish job via Cloudflare queue API', {
      route: '/api/jobs/create',
      job_id: jobId,
      user_id: user.id,
      error: error instanceof Error ? error.message : 'unknown_error'
    });
  });

  return Response.json({ job_id: jobId, status: 'pending' }, { status: 200 });
});
