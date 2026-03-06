import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';
import Stripe from 'stripe';

const stripeSecretKey = getRequiredEnv('STRIPE_SECRET_KEY');
const stripeWebhookSecret = getRequiredEnv('STRIPE_WEBHOOK_SECRET');
const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-06-20' });

const supportedEvents = new Set([
  'checkout.session.completed',
  'invoice.payment_succeeded',
  'customer.subscription.updated',
  'customer.subscription.deleted'
]);

function toUnix(value: number | null | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

export const POST = withSafeApiHandler('/api/billing/webhook', async (request: Request) => {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing Stripe signature header', { status: 400 });
  }

  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, stripeWebhookSecret);
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }

  if (!supportedEvents.has(event.type)) {
    return new Response('Ignored event', { status: 200 });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id ?? session.client_reference_id ?? undefined;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;
    const customerId = typeof session.customer === 'string' ? session.customer : null;
    const plan = session.metadata?.plan ?? null;

    if (userId && subscriptionId) {
      await adminClient.rpc('sync_user_subscription', {
        p_user_id: userId,
        p_plan: plan,
        p_status: 'active',
        p_stripe_subscription_id: subscriptionId,
        p_stripe_customer_id: customerId,
        p_current_period_end: null
      });
    }

    return new Response('ok', { status: 200 });
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object as Stripe.Invoice;
    const userId = invoice.subscription_details?.metadata?.user_id ?? invoice.lines.data[0]?.metadata?.user_id;
    const plan = invoice.subscription_details?.metadata?.plan ?? invoice.lines.data[0]?.metadata?.plan ?? null;

    const subscriptionId =
      typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription && 'id' in invoice.subscription
          ? (invoice.subscription.id as string)
          : null;

    const customerId =
      typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer && 'id' in invoice.customer
          ? (invoice.customer.id as string)
          : null;

    if (userId) {
      await adminClient.rpc('process_stripe_payment', {
        p_user_id: userId,
        p_provider_reference: event.id,
        p_amount_cents: invoice.amount_paid,
        p_currency: invoice.currency,
        p_status: 'succeeded',
        p_raw_payload: event.data.object
      });

      await adminClient.rpc('sync_user_subscription', {
        p_user_id: userId,
        p_plan: plan,
        p_status: 'active',
        p_stripe_subscription_id: subscriptionId,
        p_stripe_customer_id: customerId,
        p_current_period_end: toUnix(invoice.period_end)
      });

      await adminClient.rpc('apply_monthly_subscription_credits', { p_user_id: userId });
    }

    return new Response('ok', { status: 200 });
  }

  const subscription = event.data.object as Stripe.Subscription;
  const userId = subscription.metadata?.user_id;
  const plan = subscription.metadata?.plan ?? null;

  if (!userId) {
    return new Response('ok', { status: 200 });
  }

  const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;

  await adminClient.rpc('sync_user_subscription', {
    p_user_id: userId,
    p_plan: plan,
    p_status: status,
    p_stripe_subscription_id: subscription.id,
    p_stripe_customer_id:
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer && 'id' in subscription.customer
          ? (subscription.customer.id as string)
          : null,
    p_current_period_end: toUnix(subscription.current_period_end)
  });

  return new Response('ok', { status: 200 });
});
