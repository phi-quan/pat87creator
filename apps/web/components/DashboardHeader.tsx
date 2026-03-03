'use client';

import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabase';
import { clearAccessTokenCookie } from '../lib/authCookie';

export function DashboardHeader() {
  const router = useRouter();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    clearAccessTokenCookie();
    router.replace('/login');
    router.refresh();
  };

  return (
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <h1>Dashboard</h1>
      <button type="button" onClick={handleLogout}>
        Logout
      </button>
    </header>
  );
}
