'use client';

import { useEffect, useState } from 'react';

type MonitoringResponse = {
  jobs_last_hour: number;
  jobs_last_24_hours: number;
  jobs_success_rate: number;
  jobs_success_rate_24h: number;
  jobs_failed: number;
  dead_letter_count: number;
  avg_processing_time_ms: number;
  p95_processing_time_ms: number;
  active_jobs: number;
  queue_depth: number;
  jobs_processing: number;
  jobs_queued: number;
  jobs_dead_letter: number;
  credits_consumed_last_hour: number;
  revenue_last_hour_usd: number;
  cost_last_hour_usd: number;
  margin_last_hour_usd: number;
  revenue_today_usd: number;
  cost_today_usd: number;
  margin_today_usd: number;
  jobs_per_minute: number;
  queue_backlog_size: number;
  queue_backlog_threshold: number;
  worker_concurrency: number;
  worker_utilization: number;
  billing_integrity: {
    payments_verified: number;
    credit_mismatches: number;
    revenue_mismatch: boolean;
    anomaly_count: number;
    negative_margin_jobs: number;
    credits_verified: boolean;
    last_reconciled_at: string;
    since: string;
  };
  system_health: {
    db: boolean;
    queue: boolean;
    stripe: boolean;
  };
  refreshed_at: string;
};

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, backgroundColor: '#fff' }}>
      <p style={{ margin: 0, fontSize: 12, color: '#6b7280', textTransform: 'uppercase' }}>{title}</p>
      <p style={{ margin: '8px 0 0', fontSize: 24, fontWeight: 700 }}>{value}</p>
    </div>
  );
}

function HealthBadge({ label, healthy }: { label: string; healthy: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        backgroundColor: healthy ? '#dcfce7' : '#fee2e2',
        color: healthy ? '#166534' : '#991b1b',
        fontWeight: 600,
        fontSize: 13
      }}
    >
      {label}: {healthy ? 'healthy' : 'unhealthy'}
    </span>
  );
}

export function AdminMonitoringDashboard({ adminSecret }: { adminSecret: string }) {
  const [data, setData] = useState<MonitoringResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const fetchMetrics = async () => {
      const response = await fetch('/api/admin/monitoring', {
        headers: {
          'x-admin-secret': adminSecret
        },
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error('Failed to load monitoring metrics');
      }

      const payload = (await response.json()) as MonitoringResponse;

      if (active) {
        setData(payload);
        setError(null);
      }
    };

    fetchMetrics().catch((fetchError) => {
      if (active) {
        setError(fetchError instanceof Error ? fetchError.message : 'Unknown error');
      }
    });

    const interval = window.setInterval(() => {
      fetchMetrics().catch((fetchError) => {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : 'Unknown error');
        }
      });
    }, 12_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [adminSecret]);

  if (error) {
    return <p style={{ color: '#991b1b' }}>{error}</p>;
  }

  if (!data) {
    return <p>Loading monitoring dashboard…</p>;
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0 }}>System status</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <HealthBadge label="DB" healthy={data.system_health.db} />
          <HealthBadge label="Queue" healthy={data.system_health.queue} />
          <HealthBadge label="Stripe" healthy={data.system_health.stripe} />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Job processing</h2>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          <StatCard title="Active jobs" value={data.active_jobs} />
          <StatCard title="Queued jobs" value={data.jobs_queued} />
          <StatCard title="Failed jobs" value={data.jobs_failed} />
          <StatCard title="Dead-letter jobs" value={data.jobs_dead_letter} />
          <StatCard title="Queue depth" value={data.queue_depth} />
          <StatCard title="Queue backlog" value={data.queue_backlog_size} />
          <StatCard title="Jobs last hour" value={data.jobs_last_hour} />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Performance metrics</h2>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          <StatCard title="Avg processing (ms)" value={data.avg_processing_time_ms} />
          <StatCard title="P95 processing (ms)" value={data.p95_processing_time_ms} />
          <StatCard title="Success rate (1h)" value={`${(data.jobs_success_rate * 100).toFixed(1)}%`} />
          <StatCard title="Success rate (24h)" value={`${(data.jobs_success_rate_24h * 100).toFixed(1)}%`} />
          <StatCard title="Jobs/minute" value={data.jobs_per_minute} />
          <StatCard title="Worker utilization" value={`${(data.worker_utilization * 100).toFixed(1)}%`} />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Economic metrics</h2>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          <StatCard title="Credits consumed (1h)" value={data.credits_consumed_last_hour} />
          <StatCard title="Revenue (1h)" value={`$${data.revenue_last_hour_usd.toFixed(2)}`} />
          <StatCard title="Cost (1h)" value={`$${data.cost_last_hour_usd.toFixed(2)}`} />
          <StatCard title="Margin (1h)" value={`$${data.margin_last_hour_usd.toFixed(2)}`} />
          <StatCard title="Revenue (today)" value={`$${data.revenue_today_usd.toFixed(2)}`} />
          <StatCard title="Cost (today)" value={`$${data.cost_today_usd.toFixed(2)}`} />
          <StatCard title="Margin (today)" value={`$${data.margin_today_usd.toFixed(2)}`} />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Billing Integrity</h2>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          <StatCard title="Payments verified" value={data.billing_integrity.payments_verified} />
          <StatCard title="Credit mismatches" value={data.billing_integrity.credit_mismatches} />
          <StatCard title="Revenue mismatch" value={data.billing_integrity.revenue_mismatch ? 'Yes' : 'No'} />
          <StatCard title="Anomalies" value={data.billing_integrity.anomaly_count} />
          <StatCard title="Negative margin jobs" value={data.billing_integrity.negative_margin_jobs} />
          <StatCard title="Credits verified" value={data.billing_integrity.credits_verified ? 'Yes' : 'No'} />
        </div>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 12 }}>
          Last reconciled: {new Date(data.billing_integrity.last_reconciled_at).toLocaleString()}
        </p>
      </section>

      <p style={{ margin: 0, color: '#6b7280', fontSize: 12 }}>
        Auto-refresh every 12 seconds. Last refreshed: {new Date(data.refreshed_at).toLocaleString()}
      </p>
      <p style={{ margin: 0, color: '#6b7280', fontSize: 12 }}>
        Worker concurrency: {data.worker_concurrency}. Queue backlog threshold: {data.queue_backlog_threshold}.
      </p>
    </div>
  );
}
