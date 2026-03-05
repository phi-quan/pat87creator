'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CreateVideoForm } from './CreateVideoForm';
import { CreditBalance } from './CreditBalance';
import { JobTable } from './JobTable';
import { UsageMetrics } from './UsageMetrics';
import { useToast } from './ToastProvider';
import { supabase } from '../lib/supabase';

type JobPayload = { prompt: string };

type OptimisticJob = {
  tempId: string;
  realJobId: string;
  createdAt: string;
};

type RateLimitCode = 'jobs_per_minute' | 'concurrent_jobs' | 'daily_credits';

type RateLimitErrorResponse = {
  error: 'rate_limit_exceeded';
  code: RateLimitCode;
  message?: string;
};

const RATE_LIMIT_MESSAGES: Record<RateLimitCode, string> = {
  jobs_per_minute: 'Too many jobs submitted in a short time. Please wait.',
  concurrent_jobs: 'You already have the maximum number of active jobs.',
  daily_credits: 'Daily job cap reached for your current credit capacity.'
};

export function DashboardClient() {
  const { pushToast } = useToast();
  const [refreshKey, setRefreshKey] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [payloadByJobId, setPayloadByJobId] = useState<Record<string, JobPayload>>({});
  const [optimisticJobs, setOptimisticJobs] = useState<OptimisticJob[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!cooldownUntil || Date.now() >= cooldownUntil) {
      return;
    }

    const timer = window.setInterval(() => setTick((current) => current + 1), 1000);

    return () => window.clearInterval(timer);
  }, [cooldownUntil, tick]);

  const cooldownSeconds = useMemo(() => {
    if (!cooldownUntil) {
      return 0;
    }

    return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  }, [cooldownUntil, tick]);

  const createJob = useCallback(
    async (payload: JobPayload): Promise<boolean> => {
      if (isSubmitting) {
        return false;
      }

      if (cooldownUntil && Date.now() < cooldownUntil) {
        pushToast({ message: `Rate limited. Try again in ${cooldownSeconds}s.`, tone: 'error' });
        return false;
      }

      setIsSubmitting(true);

      const {
        data: { session }
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        pushToast({ message: 'Session expired. Please log in again.', tone: 'error' });
        setIsSubmitting(false);
        return false;
      }

      const response = await fetch('/api/jobs/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ payload })
      });

      if (response.status === 429) {
        const error = (await response.json()) as RateLimitErrorResponse;
        setCooldownUntil(Date.now() + 10_000);
        pushToast({ message: RATE_LIMIT_MESSAGES[error.code] ?? 'Rate limit exceeded.', tone: 'error' });
        setIsSubmitting(false);
        return false;
      }

      if (response.status === 402) {
        pushToast({ message: 'Insufficient credits. Please add credits before creating another job.', tone: 'error' });
        setIsSubmitting(false);
        return false;
      }

      if (!response.ok) {
        pushToast({ message: 'Something went wrong while creating the job.', tone: 'error' });
        setIsSubmitting(false);
        return false;
      }

      const { job_id } = (await response.json()) as { job_id: string };
      const tempId = `temp-${Date.now()}`;

      setPayloadByJobId((current) => ({ ...current, [job_id]: payload }));
      setOptimisticJobs((current) => [
        { tempId, realJobId: job_id, createdAt: new Date().toISOString() },
        ...current
      ]);
      setRefreshKey((current) => current + 1);
      pushToast({ message: 'Job created successfully.', tone: 'success' });
      setIsSubmitting(false);
      return true;
    },
    [cooldownSeconds, cooldownUntil, isSubmitting, pushToast]
  );

  const handleJobTerminalStatus = useCallback(
    (status: 'completed' | 'failed') => {
      if (status === 'completed') {
        pushToast({ message: 'Job completed.', tone: 'success' });
      } else {
        pushToast({ message: 'Job failed.', tone: 'error' });
      }

      setRefreshKey((current) => current + 1);
    },
    [pushToast]
  );

  const handleRealJobsSeen = useCallback((jobIds: string[]) => {
    setOptimisticJobs((current) => current.filter((job) => !jobIds.includes(job.realJobId)));
  }, []);

  const handleRetry = useCallback(
    async (jobId: string) => {
      const payload = payloadByJobId[jobId];
      if (!payload) {
        pushToast({ message: 'Cannot retry this job because original payload is unavailable.', tone: 'error' });
        return;
      }

      await createJob(payload);
    },
    [createJob, payloadByJobId, pushToast]
  );

  return (
    <>
      <UsageMetrics refreshKey={refreshKey} />
      <CreditBalance refreshKey={refreshKey} />
      <CreateVideoForm onCreateJob={createJob} isSubmitting={isSubmitting} cooldownSeconds={cooldownSeconds} />
      <JobTable
        refreshKey={refreshKey}
        optimisticJobs={optimisticJobs}
        onRealJobsSeen={handleRealJobsSeen}
        onRetry={handleRetry}
        onTerminalStatus={handleJobTerminalStatus}
      />
    </>
  );
}
