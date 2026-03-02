ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS processing_token UUID,
  ADD COLUMN IF NOT EXISTS result_payload JSONB;

CREATE INDEX IF NOT EXISTS jobs_processing_token_idx
  ON public.jobs (processing_token);
