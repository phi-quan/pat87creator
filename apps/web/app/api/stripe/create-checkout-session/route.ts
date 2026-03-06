import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';
import Stripe from 'stripe';

type CreateCheckoutSessionRequest = {
  credits?: unknown;
};

const stripeSecretKey = getRequiredEnv('STRIPE_SECRET_KEY');
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = getRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-06-20'
});

const MIN_CREDITS = 1;
const MAX_CREDITS = 100_000;

function parseCredits(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return null;
  }

  if (input < MIN_CREDITS || input > MAX_CREDITS) {
    return null;
  }

  return input;
}

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || null;
}

export const POST = withSafeApiHandler('/api/stripe/create-checkout-session', async (request: Request) => {
  if (!appUrl) {
    return Response.json({ error: 'Missing required environment variable: NEXT_PUBLIC_APP_URL' }, { status: 500 });
  }

  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let requestBody: CreateCheckoutSessionRequest;

  try {
    requestBody = (await request.json()) as CreateCheckoutSessionRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const credits = parseCredits(requestBody.credits);

  if (!credits) {
    return Response.json(
      {
        error: `Invalid credits value. Must be an integer between ${MIN_CREDITS} and ${MAX_CREDITS}.`
      },
      { status: 400 }
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/?checkout=cancelled`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: credits,
          product_data: {
            name: `${credits} credits`
          }
        }
      }
    ],
    metadata: {
      user_id: user.id
    },
    payment_intent_data: {
      metadata: {
        user_id: user.id
      }
    }
  });

  if (!session.url) {
    return Response.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }

  return Response.json({ url: session.url }, { status: 200 });
});
