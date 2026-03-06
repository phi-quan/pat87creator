export const runtime = 'edge';
import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import Stripe from 'stripe';
import { withSafeApiHandler } from '../../_lib/safeHandler';
import { PLAN_BY_KEY, parsePlan } from '../../../../lib/billing';

type CreateCheckoutSessionRequest = {
  plan?: unknown;
};

const stripeSecretKey = getRequiredEnv('STRIPE_SECRET_KEY');
const appUrl = process.env.NEXT_PUBLIC_APP_URL;

if (!appUrl) {
  throw new Error('Missing required environment variable: NEXT_PUBLIC_APP_URL');
}
const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = getRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-06-20' });

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || null;
}

export const POST = withSafeApiHandler('/api/billing/create-checkout-session', async (request: Request) => {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });

  const {
    data: { user },
    error: userError
  } = await authClient.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let requestBody: CreateCheckoutSessionRequest;

  try {
    requestBody = (await request.json()) as CreateCheckoutSessionRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const plan = parsePlan(requestBody.plan);
  if (!plan) {
    return Response.json({ error: 'Invalid plan' }, { status: 400 });
  }

  const priceId = process.env[PLAN_BY_KEY[plan].stripePriceEnv];
  if (!priceId) {
    return Response.json({ error: `Missing env ${PLAN_BY_KEY[plan].stripePriceEnv}` }, { status: 500 });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    success_url: `${appUrl}/dashboard?checkout=success`,
    cancel_url: `${appUrl}/dashboard?checkout=cancelled`,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { user_id: user.id, plan },
    subscription_data: {
      metadata: { user_id: user.id, plan }
    }
  });

  if (!session.url) {
    return Response.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }

  return Response.json({ url: session.url }, { status: 200 });
});
