import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const stripe = new Stripe(stripeSecretKey ?? '', {
  apiVersion: '2024-06-20'
});

function missingEnvResponse(name: string) {
  return new Response(`Missing required environment variable: ${name}`, { status: 500 });
}

export async function POST(request: Request) {
  if (!stripeSecretKey) {
    return missingEnvResponse('STRIPE_SECRET_KEY');
  }

  if (!stripeWebhookSecret) {
    return missingEnvResponse('STRIPE_WEBHOOK_SECRET');
  }

  if (!supabaseUrl) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_URL');
  }

  if (!supabaseServiceRoleKey) {
    return missingEnvResponse('SUPABASE_SERVICE_ROLE_KEY');
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing Stripe signature header', { status: 400 });
  }

  const rawBody = await request.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
  } catch {
    return new Response('Invalid Stripe signature', { status: 400 });
  }

  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'payment_intent.succeeded'
  ) {
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
    return new Response('Webhook handled', { status: 200 });
  }

  return new Response('Webhook handled', { status: 200 });
}
