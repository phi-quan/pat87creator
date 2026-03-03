'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void error;
  }, [error]);

  return (
    <html>
      <body>
        <main style={{ padding: 24, fontFamily: 'sans-serif', textAlign: 'center' }}>
          <h1>Something went wrong</h1>
          <p>We hit an unexpected error. Please refresh and try again.</p>
          <button onClick={() => reset()} style={{ padding: '8px 16px', cursor: 'pointer' }}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
