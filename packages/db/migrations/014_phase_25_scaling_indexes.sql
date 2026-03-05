CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at
  ON public.jobs (status, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON public.jobs (user_id, created_at DESC)';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_job_costs_created
  ON public.job_costs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_user_created
  ON public.payments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_daily_usage_user_date
  ON public.user_daily_usage (user_id, date DESC);
