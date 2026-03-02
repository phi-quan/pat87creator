import { createClient } from '@supabase/supabase-js';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type JobQueueMessage = {
  job_id: string;
  user_id: string;
  payload: Record<string, unknown>;
};

type JobRow = {
  id: string;
  status: JobStatus;
  attempt_count: number;
  locked_at: string | null;
};

type Env = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

const MAX_RETRIES = 3;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

function createServiceClient(env: Env) {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function isLockExpired(lockedAt: string | null): boolean {
  if (!lockedAt) {
    return true;
  }

  return Date.now() - new Date(lockedAt).getTime() >= PROCESSING_TIMEOUT_MS;
}

async function startProcessing(env: Env, job: JobRow): Promise<number> {
  const client = createServiceClient(env);
  const nextAttemptCount = job.attempt_count + 1;
  const nowIso = new Date().toISOString();

  const { data, error } = await client
    .from('jobs')
    .update({
      status: 'processing',
      attempt_count: nextAttemptCount,
      last_attempt_at: nowIso,
      locked_at: nowIso,
      error_message: null
    })
    .eq('id', job.id)
    .eq('status', job.status)
    .eq('attempt_count', job.attempt_count)
    .select('attempt_count')
    .maybeSingle<{ attempt_count: number }>();

  if (error) {
    throw new Error(`Unable to set processing status: ${error.message}`);
  }

  if (!data) {
    throw new Error('Unable to claim job for processing due to concurrent update');
  }

  return data.attempt_count;
}

async function updateFinalStatus(
  env: Env,
  jobId: string,
  status: 'queued' | 'completed' | 'failed',
  attemptCount: number,
  errorMessage?: string
): Promise<void> {
  const client = createServiceClient(env);
  const payload: {
    status: 'queued' | 'completed' | 'failed';
    locked_at: null;
    error_message?: string | null;
  } = {
    status,
    locked_at: null
  };

  if (status === 'failed') {
    payload.error_message = errorMessage ?? 'Unknown worker failure';
  }

  const { error } = await client
    .from('jobs')
    .update(payload)
    .eq('id', jobId)
    .eq('attempt_count', attemptCount)
    .eq('status', 'processing');

  if (error) {
    throw new Error(`Unable to update job status: ${error.message}`);
  }
}

async function simulateProcessing(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function processMessage(message: Message<JobQueueMessage>, env: Env): Promise<void> {
  const body = message.body;

  if (!body?.job_id) {
    throw new Error('Queue message missing job_id');
  }

  const client = createServiceClient(env);
  const { data: job, error: fetchError } = await client
    .from('jobs')
    .select('id, status, attempt_count, locked_at')
    .eq('id', body.job_id)
    .maybeSingle<JobRow>();

  if (fetchError) {
    throw new Error(`Unable to fetch job: ${fetchError.message}`);
  }

  if (!job) {
    console.error('Job not found for queued message', { job_id: body.job_id });
    return;
  }

  if (job.status === 'completed') {
    console.log('Skipping already completed job', {
      job_id: body.job_id,
      attempt_count: job.attempt_count,
      transition: 'completed -> completed'
    });
    return;
  }

  if (job.status === 'failed' && job.attempt_count >= MAX_RETRIES) {
    console.log('Skipping dead-lettered job', {
      job_id: body.job_id,
      attempt_count: job.attempt_count,
      transition: 'failed -> failed'
    });
    return;
  }

  if (job.status === 'processing' && !isLockExpired(job.locked_at)) {
    console.log('Skipping currently locked processing job', {
      job_id: body.job_id,
      attempt_count: job.attempt_count,
      transition: 'processing -> processing'
    });
    return;
  }

  if (job.status !== 'queued' && job.status !== 'processing' && job.status !== 'failed') {
    return;
  }

  let startedAttempt = job.attempt_count;

  try {
    startedAttempt = await startProcessing(env, job);

    console.log('Transitioning job to processing', {
      job_id: body.job_id,
      attempt_count: startedAttempt,
      transition: `${job.status} -> processing`
    });

    await simulateProcessing();

    await updateFinalStatus(env, body.job_id, 'completed', startedAttempt);

    console.log('Transitioning job to completed', {
      job_id: body.job_id,
      attempt_count: startedAttempt,
      transition: 'processing -> completed'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing failure';
    const nextStatus: 'queued' | 'failed' = startedAttempt < MAX_RETRIES ? 'queued' : 'failed';

    console.error('Video job processing failed', {
      job_id: body.job_id,
      attempt_count: startedAttempt,
      transition: `processing -> ${nextStatus}`,
      error: errorMessage
    });

    await updateFinalStatus(
      env,
      body.job_id,
      nextStatus,
      startedAttempt,
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
