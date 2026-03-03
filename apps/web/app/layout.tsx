import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { ToastProvider } from '../components/ToastProvider';

export const metadata: Metadata = {
  title: 'pat87creator',
  description: 'pat87creator MVP web app'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
