CREATE TABLE IF NOT EXISTS public.user_daily_usage (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  jobs_created INTEGER NOT NULL DEFAULT 0,
  credits_spent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS public.rate_limit_config (
  plan TEXT PRIMARY KEY,
  max_jobs_per_minute INTEGER NOT NULL,
  max_concurrent_jobs INTEGER NOT NULL,
  max_daily_credits INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_jobs_per_minute > 0),
  CHECK (max_concurrent_jobs > 0),
  CHECK (max_daily_credits > 0)
);

INSERT INTO public.rate_limit_config (plan, max_jobs_per_minute, max_concurrent_jobs, max_daily_credits)
VALUES ('default', 3, 2, 50)
ON CONFLICT (plan) DO NOTHING;

DROP TRIGGER IF EXISTS trg_rate_limit_config_set_updated_at ON public.rate_limit_config;

CREATE TRIGGER trg_rate_limit_config_set_updated_at
BEFORE UPDATE ON public.rate_limit_config
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

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
  v_jobs_last_minute integer;
  v_concurrent_jobs integer;
  v_daily_credits_spent integer;
  v_max_jobs_per_minute integer := 3;
  v_max_concurrent_jobs integer := 2;
  v_max_daily_credits integer := 50;
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

  SELECT
    max_jobs_per_minute,
    max_concurrent_jobs,
    max_daily_credits
  INTO
    v_max_jobs_per_minute,
    v_max_concurrent_jobs,
    v_max_daily_credits
  FROM public.rate_limit_config
  WHERE plan = 'default';

  SELECT id
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  INSERT INTO public.user_daily_usage (user_id, date)
  VALUES (p_user_id, CURRENT_DATE)
  ON CONFLICT (user_id, date) DO NOTHING;

  SELECT credits_spent
  INTO v_daily_credits_spent
  FROM public.user_daily_usage
  WHERE user_id = p_user_id
    AND date = CURRENT_DATE
  FOR UPDATE;

  SELECT COUNT(*)::integer
  INTO v_jobs_last_minute
  FROM public.jobs j
  INNER JOIN public.videos v ON v.id = j.video_id
  WHERE v.user_id = p_user_id
    AND j.created_at > now() - INTERVAL '1 minute';

  IF v_jobs_last_minute >= v_max_jobs_per_minute THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED|jobs_per_minute|You have reached your per-minute job limit.';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_concurrent_jobs
  FROM public.jobs j
  INNER JOIN public.videos v ON v.id = j.video_id
  WHERE v.user_id = p_user_id
    AND j.status IN ('queued', 'processing');

  IF v_concurrent_jobs >= v_max_concurrent_jobs THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED|concurrent_jobs|You have reached your concurrent job limit.';
  END IF;

  IF (COALESCE(v_daily_credits_spent, 0) + p_cost) > v_max_daily_credits THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED|daily_credits|You have reached your daily credit cap.';
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

  UPDATE public.user_daily_usage
  SET
    jobs_created = jobs_created + 1,
    credits_spent = credits_spent + p_cost
  WHERE user_id = p_user_id
    AND date = CURRENT_DATE;

  RETURN v_job_id;
END;
$$;
