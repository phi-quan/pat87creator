CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  monthly_credits INTEGER NOT NULL CHECK (monthly_credits > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.subscription_plans (id, display_name, monthly_credits)
VALUES
  ('starter', 'Starter', 10),
  ('creator', 'Creator', 50),
  ('pro', 'Pro', 200)
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    monthly_credits = EXCLUDED.monthly_credits;

CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL REFERENCES public.subscription_plans(id),
  status TEXT NOT NULL DEFAULT 'active',
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  current_period_end TIMESTAMPTZ,
  last_credited_period_start DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_subscriptions_select_own ON public.user_subscriptions;
CREATE POLICY user_subscriptions_select_own
  ON public.user_subscriptions
  FOR SELECT
  USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.user_subscriptions FROM PUBLIC;
GRANT SELECT ON TABLE public.user_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_subscriptions TO service_role;

CREATE OR REPLACE FUNCTION public.sync_user_subscription(
  p_user_id uuid,
  p_plan text,
  p_status text,
  p_stripe_subscription_id text,
  p_stripe_customer_id text,
  p_current_period_end bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text := COALESCE(NULLIF(p_plan, ''), 'starter');
  v_subscription_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.subscription_plans WHERE id = v_plan) THEN
    v_plan := 'starter';
  END IF;

  INSERT INTO public.user_subscriptions (
    user_id,
    plan,
    status,
    stripe_subscription_id,
    stripe_customer_id,
    current_period_end,
    updated_at
  )
  VALUES (
    p_user_id,
    v_plan,
    COALESCE(NULLIF(p_status, ''), 'active'),
    p_stripe_subscription_id,
    p_stripe_customer_id,
    CASE WHEN p_current_period_end IS NULL THEN NULL ELSE to_timestamp(p_current_period_end) END,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET plan = EXCLUDED.plan,
      status = EXCLUDED.status,
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, public.user_subscriptions.stripe_subscription_id),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, public.user_subscriptions.stripe_customer_id),
      current_period_end = COALESCE(EXCLUDED.current_period_end, public.user_subscriptions.current_period_end),
      updated_at = now()
  RETURNING id INTO v_subscription_id;

  RETURN v_subscription_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_monthly_subscription_credits(
  p_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text;
  v_credits integer;
  v_period_start date := date_trunc('month', now())::date;
  v_last_credited date;
BEGIN
  SELECT plan, last_credited_period_start
  INTO v_plan, v_last_credited
  FROM public.user_subscriptions
  WHERE user_id = p_user_id
    AND status IN ('active', 'trialing', 'past_due')
  FOR UPDATE;

  IF v_plan IS NULL THEN
    RETURN 0;
  END IF;

  IF v_last_credited = v_period_start THEN
    RETURN 0;
  END IF;

  SELECT monthly_credits INTO v_credits
  FROM public.subscription_plans
  WHERE id = v_plan;

  IF v_credits IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM public.add_credits(p_user_id, v_credits);

  UPDATE public.user_subscriptions
  SET last_credited_period_start = v_period_start,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN v_credits;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_monthly_credits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT user_id
    FROM public.user_subscriptions
    WHERE status IN ('active', 'trialing', 'past_due')
  LOOP
    PERFORM public.apply_monthly_subscription_credits(v_row.user_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_user_subscription(uuid, text, text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_monthly_subscription_credits(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_monthly_credits() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.sync_user_subscription(uuid, text, text, text, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_monthly_subscription_credits(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_monthly_credits() TO service_role;
