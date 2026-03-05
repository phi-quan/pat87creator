import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { dispatchAlert } from '@pat87creator/alerts/dispatcher';
import { log } from '@pat87creator/logger';

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
  ALERT_SLACK_WEBHOOK_URL?: string;
  ALERT_EMAIL_TO?: string;
  WORKER_CONCURRENCY?: string;
};

const MAX_RETRIES = 3;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ARTIFACT_BUCKET = 'videos';
const COMPUTE_COST_PER_SECOND_USD = 0.0004;
const CREDIT_PRICE_USD = 0.01;
const DEFAULT_WORKER_CONCURRENCY = 5;

if ('addEventListener' in globalThis) {
  globalThis.addEventListener('unhandledrejection', (event) => {
    const errorMessage = event.reason instanceof Error ? event.reason.message : 'unknown_reason';

    log('error', 'Unhandled promise rejection in worker-consumer', {
      reason: errorMessage
    });

    void dispatchAlert(
      {
        severity: 'warning',
        service: 'worker',
        event: 'worker_error',
        message: 'Worker Processing Failure',
        metadata: {
          error_message: errorMessage,
          worker_context: 'worker-consumer:unhandledrejection'
        }
      },
      globalThis as Env
    ).catch((error) => {
      log('error', 'Failed to dispatch unhandled rejection alert', {
        error: error instanceof Error ? error.message : 'unknown_alert_error'
      });
    });
  });
}

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

function getWorkerConcurrency(env: Env): number {
  const parsed = Number.parseInt(env.WORKER_CONCURRENCY ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKER_CONCURRENCY;
}

async function fetchJob(client: SupabaseClient, jobId: string): Promise<JobRow | null> {
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

async function startProcessing(client: SupabaseClient, job: JobRow): Promise<StartedJob> {
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

async function artifactExists(client: SupabaseClient, env: Env, artifactPath: string): Promise<boolean> {
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
  client: SupabaseClient,
  jobId: string,
  attemptCount: number,
  processingToken: string,
  payload: JobResultPayload
): Promise<void> {
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
  client: SupabaseClient,
  jobId: string,
  status: 'queued' | 'completed' | 'failed',
  attemptCount: number,
  processingToken: string,
  processingStartedAt: string,
  errorMessage?: string
): Promise<number> {
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

async function finalizeJobEconomics(client: SupabaseClient, env: Env, jobId: string, executionDurationMs: number): Promise<void> {
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
  log('info', 'Job economics finalized', {
    job_id: jobId,
    execution_duration_ms: executionDurationMs,
    total_cost_usd: result?.total_cost_usd ?? null,
    revenue_usd: result?.revenue_usd ?? null,
    margin_usd: result?.margin_usd ?? null
  });

  if ((result?.margin_usd ?? 0) < 0) {
    await dispatchAlert(
      {
        severity: 'warning',
        service: 'worker',
        event: 'margin_anomaly',
        message: 'Negative Margin Job Detected',
        metadata: {
          job_id: jobId,
          cost: result?.total_cost_usd ?? null,
          revenue: result?.revenue_usd ?? null,
          margin: result?.margin_usd ?? null,
          source: 'worker-consumer'
        }
      },
      env
    );
  }
}

async function simulateProcessing(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function processMessage(message: Message<JobQueueMessage>, env: Env, client: SupabaseClient): Promise<void> {
  const body = message.body;

  if (!body?.job_id) {
    throw new Error('Queue message missing job_id');
  }

  const job = await fetchJob(client, body.job_id);

  if (!job) {
    log('error', 'Job not found for queued message', { job_id: body.job_id, transition_reason: 'missing_job' });
    return;
  }

  if (job.status === 'completed') {
    log('info', 'Skipping already completed job', {
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
    log('info', 'Skipping dead-lettered job', {
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
    log('info', 'Skipping currently locked processing job', {
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
    started = await startProcessing(client, job);

    log('info', 'Transitioning job to processing', {
      job_id: body.job_id,
      processing_token: started.processingToken,
      attempt_count: started.attemptCount,
      transition_reason: 'claim_for_attempt',
      transition: `${job.status} -> processing`
    });

    const refreshedJob = await fetchJob(client, body.job_id);
    if (!refreshedJob) {
      throw new Error('Job disappeared after processing transition');
    }

    if (refreshedJob.status === 'completed') {
      log('info', 'Skipping heavy processing for completed job', {
        job_id: body.job_id,
        processing_token: started.processingToken,
        attempt_count: started.attemptCount,
        transition_reason: 'post_claim_refresh',
        skip_reason: 'already_completed'
      });
      return;
    }

    if (refreshedJob.result_payload) {
      log('info', 'Result payload already exists, finalizing job without heavy processing', {
        job_id: body.job_id,
        processing_token: started.processingToken,
        attempt_count: started.attemptCount,
        transition_reason: 'result_payload_guard',
        skip_reason: 'result_payload_exists'
      });

      const durationMs = await updateFinalStatus(
        client,
        body.job_id,
        'completed',
        started.attemptCount,
        started.processingToken,
        started.processingStartedAt
      );
      await finalizeJobEconomics(client, env, body.job_id, durationMs);
      return;
    }

    const artifactPath = artifactPathForJob(body.job_id);
    const existingArtifact = await artifactExists(client, env, artifactPath);

    if (existingArtifact) {
      const payload: JobResultPayload = {
        artifact_path: artifactPath,
        source: 'existing_artifact'
      };

      log('info', 'Artifact already exists, bypassing heavy processing', {
        job_id: body.job_id,
        processing_token: started.processingToken,
        attempt_count: started.attemptCount,
        transition_reason: 'artifact_exists_guard',
        skip_reason: 'artifact_exists',
        artifact_path: artifactPath
      });

      await persistResultPayload(client, body.job_id, started.attemptCount, started.processingToken, payload);
      const durationMs = await updateFinalStatus(
        client,
        body.job_id,
        'completed',
        started.attemptCount,
        started.processingToken,
        started.processingStartedAt
      );
      await finalizeJobEconomics(client, env, body.job_id, durationMs);
      return;
    }

    await simulateProcessing();

    const payload: JobResultPayload = {
      artifact_path: artifactPath,
      source: 'render'
    };

    await persistResultPayload(client, body.job_id, started.attemptCount, started.processingToken, payload);
    const durationMs = await updateFinalStatus(
      client,
      body.job_id,
      'completed',
      started.attemptCount,
      started.processingToken,
      started.processingStartedAt
    );
    await finalizeJobEconomics(client, env, body.job_id, durationMs);

    log('info', 'Transitioning job to completed', {
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

    log('error', 'Video job processing failed', {
      job_id: body.job_id,
      processing_token: started.processingToken,
      attempt_count: started.attemptCount,
      transition_reason: 'processing_error',
      transition: `processing -> ${nextStatus}`,
      error: errorMessage
    });

    await dispatchAlert(
      {
        severity: 'warning',
        service: 'worker',
        event: 'worker_error',
        message: 'Worker Processing Failure',
        metadata: {
          job_id: body.job_id,
          user_id: body.user_id,
          attempt_count: started.attemptCount,
          error_message: errorMessage,
          worker_context: 'worker-consumer:processMessage'
        }
      },
      env
    );

    try {
      await updateFinalStatus(
        client,
        body.job_id,
        nextStatus,
        started.attemptCount,
        started.processingToken,
        started.processingStartedAt,
        nextStatus === 'failed' ? errorMessage : undefined
      );

      if (nextStatus === 'failed') {
        log('warn', 'Job transitioned to dead-letter state', {
          job_id: body.job_id,
          attempt_count: started.attemptCount,
          transition: 'processing -> failed'
        });

        await dispatchAlert(
          {
            severity: 'critical',
            service: 'worker',
            event: 'dead_letter',
            message: 'Dead Letter Job Detected',
            metadata: {
              job_id: body.job_id,
              user_id: body.user_id,
              attempt_count: started.attemptCount,
              error_message: errorMessage,
              source: 'worker-consumer'
            }
          },
          env
        );
      }
    } catch (finalizeError) {
      log('error', 'Failed to finalize job status after processing error', {
        job_id: body.job_id,
        error: finalizeError instanceof Error ? finalizeError.message : 'unknown_finalize_error'
      });
      throw finalizeError;
    }
  }
}

export default {
  async queue(batch: MessageBatch<JobQueueMessage>, env: Env): Promise<void> {
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      log('error', 'Missing required worker environment variables');
      return;
    }

    const client = createServiceClient(env);
    const concurrency = getWorkerConcurrency(env);

    for (let index = 0; index < batch.messages.length; index += concurrency) {
      const chunk = batch.messages.slice(index, index + concurrency);

      await Promise.all(
        chunk.map(async (message) => {
          try {
            await processMessage(message, env, client);
            message.ack();
          } catch (error) {
            log('error', 'Unhandled queue message error', {
              message: error instanceof Error ? error.message : 'Unknown error'
            });
            message.retry();
          }
        })
      );
    }
  }
};
