DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'job_status'
      AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.job_status AS ENUM ('queued', 'processing', 'completed', 'failed');
  END IF;
END
$$;

ALTER TABLE public.jobs
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE public.job_status USING (
    CASE
      WHEN status IN ('queued', 'processing', 'completed', 'failed') THEN status::public.job_status
      WHEN status = 'pending' THEN 'queued'::public.job_status
      ELSE 'queued'::public.job_status
    END
  ),
  ALTER COLUMN status SET DEFAULT 'queued'::public.job_status;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_set_updated_at ON public.jobs;

CREATE TRIGGER trg_jobs_set_updated_at
BEFORE UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();
