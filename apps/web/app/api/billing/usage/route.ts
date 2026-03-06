import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';

type UsageRow = {
  credits_remaining: number;
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

export const GET = withSafeApiHandler('/api/billing/usage', async (request: Request) => {
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

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [creditsResult, usageResult, planResult, jobsResult] = await Promise.all([
    client.from('users').select('credits_remaining').eq('id', user.id).single<UsageRow>(),
    client
      .from('jobs')
      .select('id, videos!inner(user_id)', { count: 'exact', head: true })
      .eq('videos.user_id', user.id)
      .gte('created_at', monthStart.toISOString()),
    client.from('user_subscriptions').select('plan, status').eq('user_id', user.id).single<{ plan: string; status: string }>(),
    client
      .from('jobs')
      .select('id, status, created_at, videos!inner(user_id)')
      .eq('videos.user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5)
  ]);

  return Response.json(
    {
      credits_remaining: creditsResult.data?.credits_remaining ?? 0,
      renders_used_this_month: usageResult.count ?? 0,
      subscription_plan: planResult.data?.plan ?? 'free',
      subscription_status: planResult.data?.status ?? 'inactive',
      job_history: (jobsResult.data ?? []).map((job) => ({
        id: job.id,
        status: job.status,
        created_at: job.created_at
      }))
    },
    { status: 200 }
  );
});
