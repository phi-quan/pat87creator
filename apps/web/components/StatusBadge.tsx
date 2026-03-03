import React from 'react';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

const STATUS_STYLE_MAP: Record<JobStatus, React.CSSProperties> = {
  queued: { backgroundColor: '#e5e7eb', color: '#111827' },
  processing: { backgroundColor: '#dbeafe', color: '#1e3a8a' },
  completed: { backgroundColor: '#dcfce7', color: '#166534' },
  failed: { backgroundColor: '#fee2e2', color: '#991b1b' }
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      style={{
        ...STATUS_STYLE_MAP[status],
        display: 'inline-flex',
        borderRadius: 999,
        padding: '0.25rem 0.75rem',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'capitalize'
      }}
    >
      {status}
    </span>
  );
}
