'use client';

import { FormEvent, useState } from 'react';
import { supabase } from '../lib/supabase';

type CreateVideoFormProps = {
  onJobCreated: () => void;
};

type RateLimitCode = 'jobs_per_minute' | 'concurrent_jobs' | 'daily_credits';

type RateLimitErrorResponse = {
  error: 'rate_limit_exceeded';
  code: RateLimitCode;
};

const RATE_LIMIT_MESSAGES: Record<RateLimitCode, string> = {
  jobs_per_minute: 'Too many jobs submitted in a short time. Please wait a moment.',
  concurrent_jobs: 'You already have the maximum number of active jobs. Wait for completion.',
  daily_credits: 'Daily job cap reached for your current credit capacity.'
};

export function CreateVideoForm({ onJobCreated }: CreateVideoFormProps) {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);

  const isRateLimitBlocked = rateLimitedUntil !== null && Date.now() < rateLimitedUntil;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage('');

    if (isRateLimitBlocked) {
      setMessage('Temporarily blocked due to rate limits. Please wait and try again.');
      return;
    }

    setIsSubmitting(true);

    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      setMessage('Session expired. Please log in again.');
      setIsSubmitting(false);
      return;
    }

    const response = await fetch('/api/jobs/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ payload: { prompt } })
    });

    if (response.status === 429) {
      const payload = (await response.json()) as RateLimitErrorResponse;
      setMessage(RATE_LIMIT_MESSAGES[payload.code] ?? 'Rate limit exceeded. Try again later.');
      setRateLimitedUntil(Date.now() + 15_000);
      setIsSubmitting(false);
      return;
    }

    if (response.status === 402) {
      setMessage('Insufficient credits. Please add credits before creating another video.');
      setIsSubmitting(false);
      return;
    }

    if (!response.ok) {
      setMessage('Something went wrong while creating the job. Please try again.');
      setIsSubmitting(false);
      return;
    }

    setPrompt('');
    setMessage('Video job created successfully.');
    setIsSubmitting(false);
    onJobCreated();
  };

  return (
    <section>
      <h2>Create video</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="video-prompt">Prompt</label>
        <textarea
          id="video-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          required
          disabled={isSubmitting || isRateLimitBlocked}
        />
        <div>
          <button type="submit" disabled={isSubmitting || isRateLimitBlocked}>
            {isSubmitting ? 'Creating...' : 'Create job'}
          </button>
        </div>
      </form>
      {message ? <p>{message}</p> : null}
    </section>
  );
}
