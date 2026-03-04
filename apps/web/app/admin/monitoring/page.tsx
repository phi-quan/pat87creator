import { AdminMonitoringDashboard } from '../../../components/AdminMonitoringDashboard';

type MonitoringPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function MonitoringPage({ searchParams }: MonitoringPageProps) {
  const params = await searchParams;
  const provided = params.admin_secret;
  const providedSecret = Array.isArray(provided) ? provided[0] : provided;
  const configuredSecret = process.env.ADMIN_SECRET;

  if (!configuredSecret || !providedSecret || providedSecret !== configuredSecret) {
    return (
      <main style={{ maxWidth: 900, margin: '3rem auto', padding: '0 1rem' }}>
        <h1>Unauthorized</h1>
        <p>Provide a valid admin secret via the admin_secret query parameter.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1100, margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginTop: 0 }}>Admin Monitoring Dashboard</h1>
      <p style={{ color: '#4b5563' }}>Operational observability for queue, performance, and unit economics.</p>
      <AdminMonitoringDashboard adminSecret={providedSecret} />
    </main>
  );
}
