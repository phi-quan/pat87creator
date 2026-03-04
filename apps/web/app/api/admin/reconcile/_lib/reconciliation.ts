import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import Stripe from 'stripe';

const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const stripeSecretKey = getRequiredEnv('STRIPE_SECRET_KEY');

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-06-20'
});

const STRIPE_SCAN_LIMIT = 500;

type PaymentRow = {
  id: string;
  provider_reference: string | null;
  amount_cents: number;
  status: string;
};

type PaymentEventRow = {
  id: string;
  provider_reference: string;
  amount_cents: number;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
};

type JobRow = {
  id: string;
  billed_credits: number;
  revenue_usd: number | null;
};

type JobCostRow = {
  job_id: string;
  amount_usd: number;
};

type ReconciliationAnomaly = {
  type:
    | 'missing_internal_payment'
    | 'duplicate_internal_payment'
    | 'amount_mismatch'
    | 'credits_mismatch'
    | 'credit_consumption_mismatch'
    | 'revenue_mismatch'
    | 'negative_margin';
  message: string;
  reference?: string;
};

export type BillingReconciliationReport = {
  generated_at: string;
  payments_checked: number;
  credits_verified: boolean;
  credit_mismatches: number;
  revenue_mismatch: boolean;
  negative_margin_jobs: number;
  anomalies: ReconciliationAnomaly[];
  totals: {
    stripe_revenue_usd: number;
    internal_revenue_usd: number;
    jobs_revenue_usd: number;
    jobs_billed_credits: number;
    credits_issued_from_events: number;
  };
};

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function centsToUsd(amountCents: number): number {
  return amountCents / 100;
}

async function fetchSucceededStripePaymentIntents(): Promise<Stripe.PaymentIntent[]> {
  const intents: Stripe.PaymentIntent[] = [];
  const iterator = stripe.paymentIntents.list({ limit: 100 });

  for await (const paymentIntent of iterator) {
    if (paymentIntent.status === 'succeeded') {
      intents.push(paymentIntent);
    }

    if (intents.length >= STRIPE_SCAN_LIMIT) {
      break;
    }
  }

  return intents;
}

export async function buildBillingReconciliationReport(): Promise<BillingReconciliationReport> {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const [stripePayments, paymentsResult, paymentEventsResult, jobsResult, jobCostsResult] = await Promise.all([
    fetchSucceededStripePaymentIntents(),
    supabase.from('payments').select('id, provider_reference, amount_cents, status').eq('status', 'succeeded').returns<PaymentRow[]>(),
    supabase
      .from('payment_events')
      .select('id, provider_reference, amount_cents, status')
      .eq('status', 'succeeded')
      .returns<PaymentEventRow[]>(),
    supabase.from('jobs').select('id, billed_credits, revenue_usd').returns<JobRow[]>(),
    supabase.from('job_costs').select('job_id, amount_usd').returns<JobCostRow[]>()
  ]);

  if (paymentsResult.error || paymentEventsResult.error || jobsResult.error || jobCostsResult.error) {
    throw new Error('Failed to load financial records for reconciliation');
  }

  const payments = paymentsResult.data ?? [];
  const paymentEvents = paymentEventsResult.data ?? [];
  const jobs = jobsResult.data ?? [];
  const jobCosts = jobCostsResult.data ?? [];

  const anomalies: ReconciliationAnomaly[] = [];

  const paymentsByRef = new Map<string, PaymentRow[]>();
  for (const payment of payments) {
    if (!payment.provider_reference) {
      continue;
    }

    const existing = paymentsByRef.get(payment.provider_reference) ?? [];
    existing.push(payment);
    paymentsByRef.set(payment.provider_reference, existing);
  }

  const paymentEventsByRef = new Map<string, PaymentEventRow[]>();
  for (const eventRow of paymentEvents) {
    const existing = paymentEventsByRef.get(eventRow.provider_reference) ?? [];
    existing.push(eventRow);
    paymentEventsByRef.set(eventRow.provider_reference, existing);
  }

  let creditMismatches = 0;

  for (const stripePayment of stripePayments) {
    const paymentReference = stripePayment.id;
    const stripeAmountCents = stripePayment.amount_received || stripePayment.amount;

    const internalPayments = paymentsByRef.get(paymentReference) ?? [];
    if (internalPayments.length === 0) {
      anomalies.push({
        type: 'missing_internal_payment',
        reference: paymentReference,
        message: `No internal payments row found for Stripe payment intent ${paymentReference}`
      });
    }

    if (internalPayments.length > 1) {
      anomalies.push({
        type: 'duplicate_internal_payment',
        reference: paymentReference,
        message: `Multiple internal payments rows found for Stripe payment intent ${paymentReference}`
      });
    }

    for (const row of internalPayments) {
      if (row.amount_cents !== stripeAmountCents) {
        anomalies.push({
          type: 'amount_mismatch',
          reference: paymentReference,
          message: `Stripe amount ${stripeAmountCents}c does not match internal payment amount ${row.amount_cents}c`
        });
      }
    }

    const relatedEvents = paymentEventsByRef.get(paymentReference) ?? [];
    if (relatedEvents.length > 1) {
      anomalies.push({
        type: 'duplicate_internal_payment',
        reference: paymentReference,
        message: `Multiple payment_events rows found for Stripe payment intent ${paymentReference}`
      });
    }

    for (const eventRow of relatedEvents) {
      const expectedCredits = stripeAmountCents;
      const creditsIssued = eventRow.amount_cents;
      if (creditsIssued !== expectedCredits) {
        creditMismatches += 1;
        anomalies.push({
          type: 'credits_mismatch',
          reference: paymentReference,
          message: `Expected ${expectedCredits} credits but payment_events recorded ${creditsIssued}`
        });
      }
    }
  }

  const totalBilledCredits = jobs.reduce((sum, job) => sum + (job.billed_credits ?? 0), 0);
  const totalJobsRevenue = jobs.reduce((sum, job) => sum + (job.revenue_usd ?? 0), 0);
  const totalStripeRevenue = stripePayments.reduce(
    (sum, paymentIntent) => sum + centsToUsd(paymentIntent.amount_received || paymentIntent.amount),
    0
  );
  const totalInternalPaymentsRevenue = payments.reduce((sum, payment) => sum + centsToUsd(payment.amount_cents ?? 0), 0);
  const totalCreditsIssued = paymentEvents.reduce((sum, eventRow) => sum + (eventRow.amount_cents ?? 0), 0);

  if (totalCreditsIssued !== totalInternalPaymentsRevenue * 100) {
    creditMismatches += 1;
    anomalies.push({
      type: 'credits_mismatch',
      message: `Credits issued (${totalCreditsIssued}) do not match expected credits from internal payments (${Math.round(totalInternalPaymentsRevenue * 100)})`
    });
  }

  if (totalBilledCredits > totalCreditsIssued) {
    anomalies.push({
      type: 'credit_consumption_mismatch',
      message: `Credits consumed (${totalBilledCredits}) exceed issued credits (${totalCreditsIssued})`
    });
  }

  const revenueDiff = Math.abs(totalInternalPaymentsRevenue - totalJobsRevenue);
  const revenueMismatch = revenueDiff > 0.01;

  if (revenueMismatch) {
    anomalies.push({
      type: 'revenue_mismatch',
      message: `Revenue mismatch: payments=$${roundCurrency(totalInternalPaymentsRevenue)}, jobs=$${roundCurrency(totalJobsRevenue)}`
    });
  }

  const costByJobId = new Map<string, number>();
  for (const costRow of jobCosts) {
    const existing = costByJobId.get(costRow.job_id) ?? 0;
    costByJobId.set(costRow.job_id, existing + (costRow.amount_usd ?? 0));
  }

  let negativeMarginJobs = 0;
  for (const job of jobs) {
    const cost = costByJobId.get(job.id) ?? 0;
    const margin = (job.revenue_usd ?? 0) - cost;

    if (margin < 0) {
      negativeMarginJobs += 1;
      anomalies.push({
        type: 'negative_margin',
        reference: job.id,
        message: `Job ${job.id} has negative margin ($${roundCurrency(margin)})`
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    payments_checked: stripePayments.length,
    credits_verified: creditMismatches === 0,
    credit_mismatches: creditMismatches,
    revenue_mismatch: revenueMismatch,
    negative_margin_jobs: negativeMarginJobs,
    anomalies,
    totals: {
      stripe_revenue_usd: roundCurrency(totalStripeRevenue),
      internal_revenue_usd: roundCurrency(totalInternalPaymentsRevenue),
      jobs_revenue_usd: roundCurrency(totalJobsRevenue),
      jobs_billed_credits: totalBilledCredits,
      credits_issued_from_events: totalCreditsIssued
    }
  };
}
