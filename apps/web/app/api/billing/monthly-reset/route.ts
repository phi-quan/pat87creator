export const runtime = 'edge';
import { createClient } from '@supabase/supabase-js';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../_lib/safeHandler';

const supabaseUrl = getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

export const POST = withSafeApiHandler('/api/billing/monthly-reset', async (request: Request) => {
  const authHeader = request.headers.get('authorization');
  const expectedToken = process.env.BILLING_CRON_SECRET;

  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { error } = await adminClient.rpc('refresh_monthly_credits');
  if (error) {
    return Response.json({ error: 'Failed to refresh credits' }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
});
