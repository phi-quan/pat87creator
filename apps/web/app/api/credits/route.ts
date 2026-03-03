import { createClient } from '@supabase/supabase-js';

type CreditRow = {
  credits_remaining: number | null;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function missingEnvResponse(name: string) {
  return Response.json(
    { error: `Missing required environment variable: ${name}` },
    { status: 500 }
  );
}

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || null;
}

export async function GET(request: Request) {
  if (!supabaseUrl) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_URL');
  }

  if (!supabaseAnonKey) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

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
}
