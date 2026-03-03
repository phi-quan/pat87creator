'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { StatusBadge } from './StatusBadge';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type JobListItem = {
  id: string;
  status: JobStatus;
  created_at: string;
  video_url: string | null;
  error_message: string | null;
};

type JobsResponse = {
  data: JobListItem[];
};

type OptimisticJob = {
  tempId: string;
  realJobId: string;
  createdAt: string;
};

type JobTableProps = {
  refreshKey: number;
  optimisticJobs: OptimisticJob[];
  onRealJobsSeen: (jobIds: string[]) => void;
  onRetry: (jobId: string) => Promise<void>;
  onTerminalStatus: (status: 'completed' | 'failed') => void;
};

const POLL_INTERVAL_MS = 7000;

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function JobTable({
  refreshKey,
  optimisticJobs,
  onRealJobsSeen,
  onRetry,
  onTerminalStatus
}: JobTableProps) {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [downloadLoadingById, setDownloadLoadingById] = useState<Record<string, boolean>>({});
  const [retryLoadingById, setRetryLoadingById] = useState<Record<string, boolean>>({});
  const prevStatusByIdRef = useRef<Record<string, JobStatus>>({});

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === 'queued' || job.status === 'processing') || optimisticJobs.length > 0,
    [jobs, optimisticJobs.length]
  );

  const loadJobs = useCallback(async () => {
    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setErrorMessage('Session expired. Please log in again.');
      setIsLoading(false);
      return;
    }

    const response = await fetch('/api/jobs', {
      headers: {
        Authorization: `Bearer ${session.access_token}`
      }
    });

    if (!response.ok) {
      setErrorMessage('Failed to load jobs.');
      setIsLoading(false);
      return;
    }

    const payload = (await response.json()) as JobsResponse;

    const seenIds = payload.data.map((job) => job.id);
    onRealJobsSeen(seenIds);

    const previousStatuses = prevStatusByIdRef.current;
    for (const job of payload.data) {
      const previousStatus = previousStatuses[job.id];
      if (previousStatus && previousStatus !== job.status && (job.status === 'completed' || job.status === 'failed')) {
        onTerminalStatus(job.status);
      }
    }

    prevStatusByIdRef.current = payload.data.reduce<Record<string, JobStatus>>((acc, job) => {
      acc[job.id] = job.status;
      return acc;
    }, {});

    setJobs(payload.data);
    setErrorMessage('');
    setIsLoading(false);
  }, [onRealJobsSeen, onTerminalStatus]);

  useEffect(() => {
    setIsLoading(true);
    void loadJobs();
  }, [loadJobs, refreshKey]);

  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadJobs();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasActiveJobs, loadJobs]);

  const visibleJobs = useMemo(() => {
    const resolvedJobIds = new Set(jobs.map((job) => job.id));
    const optimisticRows: JobListItem[] = optimisticJobs
      .filter((job) => !resolvedJobIds.has(job.realJobId))
      .map((job) => ({
        id: job.tempId,
        status: 'queued',
        created_at: job.createdAt,
        video_url: null,
        error_message: null
      }));

    return [...optimisticRows, ...jobs];
  }, [jobs, optimisticJobs]);

  const handleDownload = useCallback((job: JobListItem) => {
    if (!job.video_url || downloadLoadingById[job.id]) {
      return;
    }

    setDownloadLoadingById((current) => ({ ...current, [job.id]: true }));

    try {
      const anchor = document.createElement('a');
      anchor.href = job.video_url;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      anchor.click();
    } finally {
      window.setTimeout(() => {
        setDownloadLoadingById((current) => ({ ...current, [job.id]: false }));
      }, 1000);
    }
  }, [downloadLoadingById]);

  const handleRetry = useCallback(async (jobId: string) => {
    setRetryLoadingById((current) => ({ ...current, [jobId]: true }));
    await onRetry(jobId);
    setRetryLoadingById((current) => ({ ...current, [jobId]: false }));
  }, [onRetry]);

  if (isLoading) {
    return (
      <section>
        <h2>Jobs</h2>
        <div style={{ height: 120, borderRadius: 8, background: '#f3f4f6' }} />
      </section>
    );
  }

  if (errorMessage) {
    return (
      <section>
        <h2>Jobs</h2>
        <p>{errorMessage}</p>
      </section>
    );
  }

  if (visibleJobs.length === 0) {
    return (
      <section>
        <h2>Jobs</h2>
        <p>No jobs yet. Create your first video job above.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Jobs</h2>
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Download</th>
            <th>Retry</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {visibleJobs.map((job) => (
            <tr key={job.id}>
              <td>{formatDate(job.created_at)}</td>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td>—</td>
              <td>
                {job.status === 'completed' ? (
                  <button
                    type="button"
                    onClick={() => handleDownload(job)}
                    disabled={!job.video_url || Boolean(downloadLoadingById[job.id])}
                  >
                    {downloadLoadingById[job.id] ? 'Opening...' : 'Download'}
                  </button>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {job.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => void handleRetry(job.id)}
                    disabled={Boolean(retryLoadingById[job.id])}
                  >
                    {retryLoadingById[job.id] ? 'Retrying...' : 'Retry'}
                  </button>
                ) : (
                  '—'
                )}
              </td>
              <td>{job.status === 'failed' ? job.error_message ?? 'Job failed.' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
