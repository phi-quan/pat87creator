import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { log } from '@pat87creator/logger';
import { withSafeApiHandler } from '../../_lib/safeHandler';
import Stripe from 'stripe';

const stripeSecretKey = getRequiredEnv('STRIPE_SECRET_KEY');
const stripeWebhookSecret = getRequiredEnv('STRIPE_WEBHOOK_SECRET');
const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseServiceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-06-20'
});

export async function GET() {
  return new Response('Method not allowed', { status: 405 });
}

export const POST = withSafeApiHandler('/api/stripe/webhook', async (request: Request) => {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    log('warn', 'Rejected Stripe webhook invalid content-type', { route: '/api/stripe/webhook', content_type: contentType });
    return new Response('Invalid content-type', { status: 415 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    log('warn', 'Rejected Stripe webhook missing signature', { route: '/api/stripe/webhook' });
    return new Response('Missing Stripe signature header', { status: 400 });
  }

  const rawBody = await request.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
  } catch {
    log('warn', 'Stripe webhook signature verification failed', { route: '/api/stripe/webhook' });
    return new Response('Invalid Stripe signature', { status: 400 });
  }

  if (event.type !== 'checkout.session.completed' && event.type !== 'payment_intent.succeeded') {
    return new Response('Ignored event', { status: 200 });
  }

  let userId: string | undefined;
  let amountCents: number | undefined;

  if (event.type === 'checkout.session.completed') {
    const checkoutSession = event.data.object as Stripe.Checkout.Session;
    userId = checkoutSession.metadata?.user_id;
    amountCents = checkoutSession.amount_total ?? undefined;
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    userId = paymentIntent.metadata?.user_id;
    amountCents = paymentIntent.amount_received ?? paymentIntent.amount;
  }

  if (!userId || amountCents === undefined) {
    return new Response('Missing required metadata', { status: 200 });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { error } = await supabaseAdmin.rpc('process_stripe_payment', {
    p_user_id: userId,
    p_amount_cents: amountCents,
    p_status: 'succeeded',
    p_provider_reference: event.id
  });

  if (error) {
    log('warn', 'Stripe webhook process_stripe_payment RPC failed', { route: '/api/stripe/webhook', provider_reference: event.id });
  }

  return new Response('Webhook handled', { status: 200 });
});
