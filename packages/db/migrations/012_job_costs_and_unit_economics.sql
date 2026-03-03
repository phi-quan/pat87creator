ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS revenue_usd NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS billed_credits INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.job_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  cost_type TEXT NOT NULL CHECK (cost_type IN ('compute', 'storage', 'external_api')),
  amount_usd NUMERIC(10,6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, cost_type)
);

CREATE INDEX IF NOT EXISTS job_costs_job_id_idx ON public.job_costs(job_id);



CREATE OR REPLACE FUNCTION public.create_video_job(
  p_user_id uuid,
  p_cost integer,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
  v_video_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User id is required';
  END IF;

  IF p_cost IS NULL OR p_cost <= 0 THEN
    RAISE EXCEPTION 'Cost must be greater than zero';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Payload must be a JSON object';
  END IF;

  BEGIN
    v_video_id := (p_payload ->> 'video_id')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Payload video_id must be a valid UUID';
  END;

  IF v_video_id IS NULL THEN
    RAISE EXCEPTION 'Payload video_id is required';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', p_user_id::text, true);

  PERFORM public.deduct_credits(p_cost);

  INSERT INTO public.jobs (video_id, billed_credits)
  SELECT v.id, p_cost
  FROM public.videos AS v
  WHERE v.id = v_video_id
    AND v.user_id = p_user_id
  RETURNING id INTO v_job_id;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'Video not found for user';
  END IF;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_job_economics(
  p_job_id uuid,
  p_compute_cost_usd numeric,
  p_storage_cost_usd numeric DEFAULT 0,
  p_external_api_cost_usd numeric DEFAULT 0,
  p_credit_price_usd numeric DEFAULT 0.01
)
RETURNS TABLE(total_cost_usd numeric, revenue_usd numeric, margin_usd numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_billed_credits integer;
  v_revenue_usd numeric(10,6);
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'Job id is required';
  END IF;

  IF p_credit_price_usd IS NULL OR p_credit_price_usd <= 0 THEN
    RAISE EXCEPTION 'Credit price must be positive';
  END IF;

  IF COALESCE(p_compute_cost_usd, 0) < 0
     OR COALESCE(p_storage_cost_usd, 0) < 0
     OR COALESCE(p_external_api_cost_usd, 0) < 0 THEN
    RAISE EXCEPTION 'Costs must be non-negative';
  END IF;

  SELECT billed_credits
  INTO v_billed_credits
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_billed_credits IS NULL THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  v_revenue_usd := ROUND((v_billed_credits::numeric * p_credit_price_usd)::numeric, 6);

  IF COALESCE(p_compute_cost_usd, 0) > 0 THEN
    INSERT INTO public.job_costs (job_id, cost_type, amount_usd)
    VALUES (p_job_id, 'compute', ROUND(p_compute_cost_usd::numeric, 6))
    ON CONFLICT (job_id, cost_type)
    DO UPDATE SET amount_usd = EXCLUDED.amount_usd;
  END IF;

  IF COALESCE(p_storage_cost_usd, 0) > 0 THEN
    INSERT INTO public.job_costs (job_id, cost_type, amount_usd)
    VALUES (p_job_id, 'storage', ROUND(p_storage_cost_usd::numeric, 6))
    ON CONFLICT (job_id, cost_type)
    DO UPDATE SET amount_usd = EXCLUDED.amount_usd;
  END IF;

  IF COALESCE(p_external_api_cost_usd, 0) > 0 THEN
    INSERT INTO public.job_costs (job_id, cost_type, amount_usd)
    VALUES (p_job_id, 'external_api', ROUND(p_external_api_cost_usd::numeric, 6))
    ON CONFLICT (job_id, cost_type)
    DO UPDATE SET amount_usd = EXCLUDED.amount_usd;
  END IF;

  UPDATE public.jobs
  SET revenue_usd = v_revenue_usd
  WHERE id = p_job_id;

  RETURN QUERY
  WITH summed AS (
    SELECT COALESCE(SUM(amount_usd), 0)::numeric(10,6) AS summed_cost
    FROM public.job_costs
    WHERE job_id = p_job_id
  )
  SELECT
    summed.summed_cost,
    v_revenue_usd::numeric(10,6),
    (v_revenue_usd - summed.summed_cost)::numeric(10,6)
  FROM summed;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_job_economics(uuid, numeric, numeric, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_job_economics(uuid, numeric, numeric, numeric, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_job_economics(uuid, numeric, numeric, numeric, numeric) TO service_role;

CREATE OR REPLACE VIEW public.admin_job_metrics AS
SELECT
  COUNT(*)::int AS total_jobs,
  COUNT(*) FILTER (WHERE j.status = 'completed')::int AS completed,
  COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed,
  COUNT(*) FILTER (WHERE j.status = 'processing')::int AS processing,
  COUNT(*) FILTER (WHERE j.status = 'queued')::int AS queued,
  COALESCE(ROUND(AVG(j.execution_duration_ms) FILTER (WHERE j.execution_duration_ms IS NOT NULL)), 0)::int AS avg_execution_ms,
  COALESCE(
    ROUND((COUNT(*) FILTER (WHERE j.attempt_count > 1)::numeric / NULLIF(COUNT(*), 0)::numeric), 4),
    0
  ) AS retry_rate,
  COALESCE(SUM(c.total_cost), 0)::numeric(12,6) AS total_cost_usd,
  COALESCE(SUM(j.revenue_usd), 0)::numeric(12,6) AS total_revenue_usd,
  COALESCE(SUM(j.revenue_usd), 0)::numeric(12,6) - COALESCE(SUM(c.total_cost), 0)::numeric(12,6) AS total_margin_usd,
  COALESCE(
    ROUND(
      (
        (COALESCE(SUM(j.revenue_usd), 0)::numeric - COALESCE(SUM(c.total_cost), 0)::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE j.status = 'completed'), 0)::numeric
      ),
      6
    ),
    0
  )::numeric(12,6) AS avg_margin_per_job
FROM public.jobs j
LEFT JOIN (
  SELECT job_id, SUM(amount_usd)::numeric(12,6) AS total_cost
  FROM public.job_costs
  GROUP BY job_id
) c ON c.job_id = j.id;
