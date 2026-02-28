'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type UserRow = {
  credits_remaining: number | null;
};

export default function HomePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [creditsRemaining, setCreditsRemaining] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState('Loading session...');

  useEffect(() => {
    const loadSession = async () => {
      const {
        data: { session: currentSession },
        error,
      } = await supabase.auth.getSession();

      if (error) {
        setStatusMessage(error.message);
        return;
      }

      setSession(currentSession);

      if (!currentSession) {
        setCreditsRemaining(null);
        setStatusMessage('Not logged in.');
        return;
      }

      const { data: userRow, error: userError } = await supabase
        .from('users')
        .select('credits_remaining')
        .eq('id', currentSession.user.id)
        .single<UserRow>();

      if (userError) {
        setStatusMessage(userError.message);
        return;
      }

      setCreditsRemaining(userRow?.credits_remaining ?? null);
      setStatusMessage('Logged in.');
    };

    void loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, updatedSession) => {
      setSession(updatedSession);
      if (!updatedSession) {
        setCreditsRemaining(null);
        setStatusMessage('Not logged in.');
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      setStatusMessage(error.message);
      return;
    }

    setSession(null);
    setCreditsRemaining(null);
    setStatusMessage('Logged out.');
  };

  return (
    <main>
      <h1>pat87creator MVP</h1>
      <p>{statusMessage}</p>

      {session ? (
        <section>
          <p>Logged in as: {session.user.email}</p>
          <p>Credits remaining: {creditsRemaining ?? 'Not available'}</p>
          <button onClick={handleLogout} type="button">
            Logout
          </button>
        </section>
      ) : (
        <section>
          <p>
            <Link href="/signup">Create an account</Link>
          </p>
          <p>
            <Link href="/login">Log in</Link>
          </p>
        </section>
      )}
    </main>
  );
}
