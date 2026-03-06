export const runtime = 'edge';
import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';

type SubscriptionRow = {
  plan: string;
  status: string;
  current_period_end: string | null;
};

const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = getRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || null;
}

export const GET = withSafeApiHandler('/api/billing/subscription', async (request: Request) => {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });

  const {
    data: { user },
    error: userError
  } = await client.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await client
    .from('user_subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', user.id)
    .single<SubscriptionRow>();

  if (error) {
    return Response.json({ plan: 'free', status: 'inactive', current_period_end: null }, { status: 200 });
  }

  return Response.json(data, { status: 200 });
});
