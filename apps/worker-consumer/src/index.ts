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
};

type Env = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

function createServiceClient(env: Env) {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

async function updateJobStatus(
  env: Env,
  jobId: string,
  status: JobStatus,
  errorMessage?: string
): Promise<void> {
  const client = createServiceClient(env);
  const payload: { status: JobStatus; error_message?: string | null } = { status };

  if (status === 'failed') {
    payload.error_message = errorMessage ?? 'Unknown worker failure';
  } else {
    payload.error_message = null;
  }

  const { error } = await client.from('jobs').update(payload).eq('id', jobId);

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
    .select('id, status')
    .eq('id', body.job_id)
    .maybeSingle<JobRow>();

  if (fetchError) {
    throw new Error(`Unable to fetch job: ${fetchError.message}`);
  }

  if (!job) {
    console.error('Job not found for queued message', { jobId: body.job_id });
    return;
  }

  if (job.status === 'completed') {
    console.log('Skipping already completed job', { jobId: body.job_id });
    return;
  }

  if (job.status !== 'queued') {
    console.log('Skipping job because status is not queued', {
      jobId: body.job_id,
      status: job.status
    });
    return;
  }

  try {
    await updateJobStatus(env, body.job_id, 'processing');
    await simulateProcessing();
    await updateJobStatus(env, body.job_id, 'completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown processing failure';

    console.error('Video job processing failed', {
      jobId: body.job_id,
      userId: body.user_id,
      message: errorMessage
    });

    await updateJobStatus(env, body.job_id, 'failed', errorMessage);
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
