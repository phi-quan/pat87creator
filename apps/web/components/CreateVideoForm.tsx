'use client';

import { FormEvent, useState } from 'react';

type CreateVideoFormProps = {
  onCreateJob: (payload: { prompt: string }) => Promise<boolean>;
  isSubmitting: boolean;
  cooldownSeconds: number;
};

export function CreateVideoForm({ onCreateJob, isSubmitting, cooldownSeconds }: CreateVideoFormProps) {
  const [prompt, setPrompt] = useState('');

  const isRateLimited = cooldownSeconds > 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const didCreate = await onCreateJob({ prompt });
    if (didCreate) {
      setPrompt('');
    }
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
          disabled={isSubmitting || isRateLimited}
        />
        <div>
          <button type="submit" disabled={isSubmitting || isRateLimited}>
            {isSubmitting ? 'Creating...' : isRateLimited ? `Wait ${cooldownSeconds}s` : 'Create job'}
          </button>
        </div>
      </form>
    </section>
  );
}
