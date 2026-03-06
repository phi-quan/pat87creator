export const runtime = 'edge';
import { getRequiredEnv } from '@pat87creator/config/env';
import { withSafeApiHandler } from '../../../_lib/safeHandler';
import { buildBillingReconciliationReport } from '../_lib/reconciliation';

export const GET = withSafeApiHandler('/api/admin/reconcile/report', async (request: Request) => {
  const adminSecret = getRequiredEnv('ADMIN_SECRET');
  const incomingSecret = request.headers.get('x-admin-secret');

  if (!incomingSecret || incomingSecret !== adminSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const since = new URL(request.url).searchParams.get('since') ?? undefined;
  const report = await buildBillingReconciliationReport({ since });

  return Response.json(report, { status: 200 });
});
