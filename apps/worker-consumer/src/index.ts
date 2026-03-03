import { createClient } from '@supabase/supabase-js';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type JobQueueMessage = {
  job_id: string;
  user_id: string;
  payload: Record<string, unknown>;
};

type JobResultPayload = {
  artifact_path: string;
  source: 'render' | 'existing_artifact';
};

type JobRow = {
  id: string;
  status: JobStatus;
  attempt_count: number;
  locked_at: string | null;
  processing_token: string | null;
  result_payload: JobResultPayload | null;
  processing_started_at: string | null;
};

type FinalizeEconomicsRow = {
  total_cost_usd: number;
  revenue_usd: number;
  margin_usd: number;
};

type StartedJob = {
  attemptCount: number;
  processingToken: string;
  processingStartedAt: string;
};

type Env = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ARTIFACT_BUCKET?: string;
};

const MAX_RETRIES = 3;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ARTIFACT_BUCKET = 'videos';
const COMPUTE_COST_PER_SECOND_USD = 0.0004;
const CREDIT_PRICE_USD = 0.01;

function createServiceClient(env: Env) {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function artifactPathForJob(jobId: string): string {
  return `video_${jobId}.mp4`;
}

function isLockExpired(lockedAt: string | null): boolean {
  if (!lockedAt) {
    return true;
  }

  return Date.now() - new Date(lockedAt).getTime() >= PROCESSING_TIMEOUT_MS;
}

async function fetchJob(env: Env, jobId: string): Promise<JobRow | null> {
  const client = createServiceClient(env);
  const { data, error } = await client
    .from('jobs')
    .select('id, status, attempt_count, locked_at, processing_token, result_payload, processing_started_at')
    .eq('id', jobId)
    .maybeSingle<JobRow>();

  if (error) {
    throw new Error(`Unable to fetch job: ${error.message}`);
  }

  return data;
}

async function startProcessing(env: Env, job: JobRow): Promise<StartedJob> {
  const client = createServiceClient(env);
  const nextAttemptCount = job.attempt_count + 1;
  const nowIso = new Date().toISOString();
  const processingToken = crypto.randomUUID();

  const { data, error } = await client
    .from('jobs')
    .update({
      status: 'processing',
      attempt_count: nextAttemptCount,
      last_attempt_at: nowIso,
      locked_at: nowIso,
      processing_token: processingToken,
      error_message: null,
      processing_started_at: nowIso
    })
    .eq('id', job.id)
    .eq('status', job.status)
    .eq('attempt_count', job.attempt_count)
    .select('attempt_count, processing_token')
    .maybeSingle<{ attempt_count: number; processing_token: string | null }>();

  if (error) {
    throw new Error(`Unable to set processing status: ${error.message}`);
  }

  if (!data?.processing_token) {
    throw new Error('Unable to claim job for processing due to concurrent update');
  }

  return {
    attemptCount: data.attempt_count,
    processingToken: data.processing_token,
    processingStartedAt: nowIso
  };
}

async function artifactExists(env: Env, artifactPath: string): Promise<boolean> {
  const client = createServiceClient(env);
  const bucket = env.SUPABASE_ARTIFACT_BUCKET || DEFAULT_ARTIFACT_BUCKET;

  const { data, error } = await client.storage.from(bucket).list('', {
    search: artifactPath,
    limit: 1
  });

  if (error) {
    throw new Error(`Unable to check artifact existence: ${error.message}`);
  }

  return (data ?? []).some((file) => file.name === artifactPath);
}

async function persistResultPayload(
  env: Env,
  jobId: string,
  attemptCount: number,
  processingToken: string,
  payload: JobResultPayload
): Promise<void> {
  const client = createServiceClient(env);
  const { error } = await client
    .from('jobs')
    .update({ result_payload: payload })
    .eq('id', jobId)
    .eq('status', 'processing')
    .eq('attempt_count', attemptCount)
    .eq('processing_token', processingToken);

  if (error) {
    throw new Error(`Unable to persist result payload: ${error.message}`);
  }
}

async function updateFinalStatus(
  env: Env,
  jobId: string,
  status: 'queued' | 'completed' | 'failed',
  attemptCount: number,
  processingToken: string,
  processingStartedAt: string,
  errorMessage?: string
): Promise<number> {
  const client = createServiceClient(env);
  const payload: {
    status: 'queued' | 'completed' | 'failed';
    locked_at: null;
    error_message?: string | null;
    processing_completed_at?: string | null;
    execution_duration_ms?: number | null;
  } = {
    status,
    locked_at: null
  };

  const processingCompletedAt = new Date().toISOString();
  const durationMs = Math.max(0, new Date(processingCompletedAt).getTime() - new Date(processingStartedAt).getTime());
  payload.processing_completed_at = processingCompletedAt;
  payload.execution_duration_ms = durationMs;

  if (status === 'failed') {
    payload.error_message = errorMessage ?? 'Unknown worker failure';
  }

  if (status === 'queued') {
    payload.error_message = null;
  }

  const { error } = await client
    .from('jobs')
    .update(payload)
    .eq('id', jobId)
    .eq('attempt_count', attemptCount)
    .eq('status', 'processing')
    .eq('processing_token', processingToken);

  if (error) {
    throw new Error(`Unable to update job status: ${error.message}`);
  }

  return durationMs;
}

async function finalizeJobEconomics(env: Env, jobId: string, executionDurationMs: number): Promise<void> {
  const client = createServiceClient(env);
  const computeCostUsd = (executionDurationMs / 1000) * COMPUTE_COST_PER_SECOND_USD;

  const { data, error } = await client.rpc('finalize_job_economics', {
    p_job_id: jobId,
    p_compute_cost_usd: computeCostUsd,
    p_storage_cost_usd: 0,
    p_external_api_cost_usd: 0,
    p_credit_price_usd: CREDIT_PRICE_USD
  });

  if (error) {
    throw new Error(`Unable to finalize job economics: ${error.message}`);
  }

  const result = (Array.isArray(data) ? data[0] : data) as FinalizeEconomicsRow | null;
  console.log('Job economics finalized', {
    job_id: jobId,
    execution_duration_ms: executionDurationMs,
    total_cost_usd: result?.total_cost_usd ?? null,
    revenue_usd: result?.revenue_usd ?? null,
    margin_usd: result?.margin_usd ?? null
  });
}

async function simulateProcessing(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function processMessage(message: Message<JobQueueMessage>, env: Env): Promise<void> {
  const body = message.body;

  if (!body?.job_id) {
    throw new Error('Queue message missing job_id');
  }

  const job = await fetchJob(env, body.job_id);

  if (!job) {
    console.error('Job not found for queued message', { job_id: body.job_id, transition_reason: 'missing_job' });
    return;
  }

  if (job.status === 'completed') {
    console.log('Skipping already completed job', {
      job_id: body.job_id,
      processing_token: job.processing_token,
      attempt_count: job.attempt_count,
      transition_reason: 'completed_guard',
      skip_reason: 'already_completed',
      transition: 'completed -> completed'
    });
    return;
  }

  if (job.status === 'failed' && job.attempt_count >= MAX_RETRIES) {
    console.log('Skipping dead-lettered job', {
      job_id: body.job_id,
      processing_token: job.processing_token,
      attempt_count: job.attempt_count,
      transition_reason: 'dead_letter_guard',
      skip_reason: 'max_retries_reached',
      transition: 'failed -> failed'
    });
    return;
  }

  if (job.status === 'processing' && !isLockExpired(job.locked_at)) {
    console.log('Skipping currently locked processing job', {
      job_id: body.job_id,
      processing_token: job.processing_token,
      attempt_count: job.attempt_count,
      transition_reason: 'lock_guard',
      skip_reason: 'active_lock',
      transition: 'processing -> processing'
    });
    return;
  }

  if (job.status !== 'queued' && job.status !== 'processing' && job.status !== 'failed') {
    return;
  }

  let started: StartedJob | null = null;

  try {
    started = await startProcessing(env, job);

    console.log('Transitioning job to processing', {
      job_id: body.job_id,
      processing_token: started.processingToken,
      attempt_count: started.attemptCount,
      transition_reason: 'claim_for_attempt',
      transition: `${job.status} -> processing`
    });

    const refreshedJob = await fetchJob(env, body.job_id);
    if (!refreshedJob) {
      throw new Error('Job disappeared after processing transition');
    }

    if (refreshedJob.status === 'completed') {
      console.log('Skipping heavy processing for completed job', {
        job_id: body.job_id,
        processing_token: started.processingToken,
        attempt_count: started.attemptCount,
        transition_reason: 'post_claim_refresh',
        skip_reason: 'already_completed'
      });
      return;
    }

    if (refreshedJob.result_payload) {
      console.log('Result payload already exists, finalizing job without heavy processing', {
        job_id: body.job_id,
        processing_token: started.processingToken,
        attempt_count: started.attemptCount,
        transition_reason: 'result_payload_guard',
        skip_reason: 'result_payload_exists'
      });

      const durationMs = await updateFinalStatus(
        env,
        body.job_id,
        'completed',
        started.attemptCount,
        started.processingToken,
        started.processingStartedAt
      );
      await finalizeJobEconomics(env, body.job_id, durationMs);
      return;
    }

    const artifactPath = artifactPathForJob(body.job_id);
    const existingArtifact = await artifactExists(env, artifactPath);

    if (existingArtifact) {
      const payload: JobResultPayload = {
        artifact_path: artifactPath,
        source: 'existing_artifact'
      };

      console.log('Artifact already exists, bypassing heavy processing', {
        job_id: body.job_id,
        processing_token: started.processingToken,
        attempt_count: started.attemptCount,
        transition_reason: 'artifact_exists_guard',
        skip_reason: 'artifact_exists',
        artifact_path: artifactPath
      });

      await persistResultPayload(env, body.job_id, started.attemptCount, started.processingToken, payload);
      const durationMs = await updateFinalStatus(
        env,
        body.job_id,
        'completed',
        started.attemptCount,
        started.processingToken,
        started.processingStartedAt
      );
      await finalizeJobEconomics(env, body.job_id, durationMs);
      return;
    }

    await simulateProcessing();

    const payload: JobResultPayload = {
      artifact_path: artifactPath,
      source: 'render'
    };

    await persistResultPayload(env, body.job_id, started.attemptCount, started.processingToken, payload);
    const durationMs = await updateFinalStatus(
      env,
      body.job_id,
      'completed',
      started.attemptCount,
      started.processingToken,
      started.processingStartedAt
    );
    await finalizeJobEconomics(env, body.job_id, durationMs);

    console.log('Transitioning job to completed', {
      job_id: body.job_id,
      processing_token: started.processingToken,
      attempt_count: started.attemptCount,
      transition_reason: 'external_work_success',
      transition: 'processing -> completed',
      artifact_path: artifactPath
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing failure';

    if (!started) {
      throw error;
    }

    const nextStatus: 'queued' | 'failed' = started.attemptCount < MAX_RETRIES ? 'queued' : 'failed';

    console.error('Video job processing failed', {
      job_id: body.job_id,
      processing_token: started.processingToken,
      attempt_count: started.attemptCount,
      transition_reason: 'processing_error',
      transition: `processing -> ${nextStatus}`,
      error: errorMessage
    });

    await updateFinalStatus(
      env,
      body.job_id,
      nextStatus,
      started.attemptCount,
      started.processingToken,
      started.processingStartedAt,
      nextStatus === 'failed' ? errorMessage : undefined
    );
  }
}

export default {
  async queue(batch: MessageBatch<JobQueueMessage>, env: Env): Promise<void> {
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing required worker environment variables');
      return;
    }

    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        console.error('Unhandled queue message error', {
          message: error instanceof Error ? error.message : 'Unknown error'
        });
        message.retry();
      }
    }
  }
};
