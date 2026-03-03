ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_duration_ms INTEGER;

CREATE OR REPLACE VIEW public.admin_job_metrics AS
SELECT
  COUNT(*)::int AS total_jobs,
  COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
  COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
  COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
  COALESCE(ROUND(AVG(execution_duration_ms) FILTER (WHERE execution_duration_ms IS NOT NULL)), 0)::int AS avg_execution_ms,
  COALESCE(
    ROUND((COUNT(*) FILTER (WHERE attempt_count > 1)::numeric / NULLIF(COUNT(*), 0)::numeric), 4),
    0
  ) AS retry_rate
FROM public.jobs;
