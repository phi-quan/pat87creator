import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { DashboardHeader } from '../../components/DashboardHeader';
import { ACCESS_TOKEN_COOKIE_NAME } from '../../lib/authCookie';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function validateServerSession() {
  if (!supabaseUrl || !supabaseAnonKey) {
    return false;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_TOKEN_COOKIE_NAME)?.value;
  if (!token) {
    return false;
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });

  const {
    data: { user },
    error
  } = await client.auth.getUser();

  return Boolean(!error && user);
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const hasValidSession = await validateServerSession();

  if (!hasValidSession) {
    redirect('/login');
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: '100vh' }}>
      <aside style={{ borderRight: '1px solid #e5e7eb', padding: '1rem' }}>
        <strong>Navigation</strong>
        <nav>
          <ul>
            <li>Dashboard</li>
            <li>Create Job</li>
            <li>History</li>
          </ul>
        </nav>
      </aside>
      <main style={{ padding: '1rem' }}>
        <DashboardHeader />
        {children}
      </main>
    </div>
  );
}
