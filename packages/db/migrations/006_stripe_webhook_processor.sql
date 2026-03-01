CREATE OR REPLACE FUNCTION public.process_stripe_payment(
  p_user_id uuid,
  p_provider_reference text,
  p_amount_cents integer,
  p_currency text,
  p_status public.payment_status,
  p_raw_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_event_id uuid;
BEGIN
  INSERT INTO public.payment_events (
    user_id,
    provider,
    provider_reference,
    amount_cents,
    currency,
    status,
    raw_payload
  )
  VALUES (
    p_user_id,
    'stripe',
    p_provider_reference,
    p_amount_cents,
    p_currency,
    p_status,
    p_raw_payload
  )
  ON CONFLICT (provider, provider_reference) DO NOTHING
  RETURNING id INTO v_payment_event_id;

  IF v_payment_event_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_status = 'succeeded' THEN
    PERFORM public.add_credits(p_user_id, p_amount_cents);
  END IF;

  RETURN v_payment_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.process_stripe_payment(
  uuid,
  text,
  integer,
  text,
  public.payment_status,
  jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_stripe_payment(
  uuid,
  text,
  integer,
  text,
  public.payment_status,
  jsonb
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.process_stripe_payment(
  uuid,
  text,
  integer,
  text,
  public.payment_status,
  jsonb
) TO service_role;
