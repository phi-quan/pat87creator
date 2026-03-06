export const runtime = 'edge';
import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../_lib/safeHandler';

type CreditRow = {
  credits_remaining: number | null;
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

export const GET = withSafeApiHandler('/api/credits', async (request: Request) => {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
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
  } = await client.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await client
    .from('users')
    .select('credits_remaining')
    .eq('id', user.id)
    .single<CreditRow>();

  if (error) {
    return Response.json({ error: 'Failed to fetch credit balance' }, { status: 500 });
  }

  return Response.json({ credits_remaining: data?.credits_remaining ?? 0 }, { status: 200 });
});
