'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type CreditBalanceProps = {
  refreshKey: number;
};

export function CreditBalance({ refreshKey }: CreditBalanceProps) {
  const [credits, setCredits] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const loadCredits = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setErrorMessage('Session expired. Please log in again.');
      setCredits(null);
      setIsLoading(false);
      return;
    }

    const response = await fetch('/api/credits', {
      headers: {
        Authorization: `Bearer ${session.access_token}`
      }
    });

    if (response.status === 401) {
      setErrorMessage('Session expired. Please log in again.');
      setCredits(null);
      setIsLoading(false);
      return;
    }

    if (!response.ok) {
      setErrorMessage('Unable to load credits right now.');
      setCredits(null);
      setIsLoading(false);
      return;
    }

    const payload = (await response.json()) as { credits_remaining: number };
    setCredits(payload.credits_remaining);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadCredits();
  }, [loadCredits, refreshKey]);

  if (isLoading) {
    return <p>Credits: Loading...</p>;
  }

  if (errorMessage) {
    return <p>{errorMessage}</p>;
  }

  return <p>Credits: {credits ?? 0}</p>;
}
