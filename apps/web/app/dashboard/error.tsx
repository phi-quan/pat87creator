'use client';

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ padding: '1rem' }}>
      <h2>Something went wrong in the dashboard.</h2>
      <p>Please reload or try again.</p>
      <button type="button" onClick={() => reset()}>
        Reload
      </button>
    </div>
  );
}
