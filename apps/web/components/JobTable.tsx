'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

type JobTableProps = {
  refreshKey: number;
};

const POLL_INTERVAL_MS = 7000;

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function JobTable({ refreshKey }: JobTableProps) {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === 'queued' || job.status === 'processing'),
    [jobs]
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
    setJobs(payload.data);
    setErrorMessage('');
    setIsLoading(false);
  }, []);

  useEffect(() => {
    setIsLoading(true);
    void loadJobs();
  }, [loadJobs, refreshKey]);

  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }

    const timer = setInterval(() => {
      void loadJobs();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [hasActiveJobs, loadJobs]);

  if (isLoading) {
    return (
      <section>
        <h2>Jobs</h2>
        <p>Loading jobs...</p>
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

  if (jobs.length === 0) {
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
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>{formatDate(job.created_at)}</td>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td>—</td>
              <td>
                {job.status === 'completed' && job.video_url ? (
                  <a href={job.video_url} target="_blank" rel="noreferrer">
                    Download
                  </a>
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
