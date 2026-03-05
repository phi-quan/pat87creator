'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type UsagePayload = {
  credits_remaining: number;
  renders_used_this_month: number;
  subscription_plan: string;
  subscription_status: string;
};

type UsageMetricsProps = {
  refreshKey: number;
};

export function UsageMetrics({ refreshKey }: UsageMetricsProps) {
  const [data, setData] = useState<UsagePayload | null>(null);

  useEffect(() => {
    const run = async () => {
      const {
        data: { session }
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setData(null);
        return;
      }

      const response = await fetch('/api/billing/usage', {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });

      if (!response.ok) {
        setData(null);
        return;
      }

      const payload = (await response.json()) as UsagePayload;
      setData(payload);
    };

    void run();
  }, [refreshKey]);

  if (!data) {
    return <p>Usage metrics unavailable.</p>;
  }

  return (
    <section style={{ marginBottom: 12 }}>
      <p>Plan: {data.subscription_plan} ({data.subscription_status})</p>
      <p>Remaining credits: {data.credits_remaining}</p>
      <p>Renders used this month: {data.renders_used_this_month}</p>
    </section>
  );
}
