DROP POLICY IF EXISTS users_update_own ON public.users;

CREATE OR REPLACE FUNCTION public.deduct_credits(amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_credits integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  UPDATE public.users
  SET credits_remaining = credits_remaining - amount
  WHERE id = auth.uid()
    AND credits_remaining >= amount
  RETURNING credits_remaining INTO updated_credits;

  IF updated_credits IS NULL THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  RETURN updated_credits;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_credits(user_id uuid, amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_credits integer;
BEGIN
  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  UPDATE public.users
  SET credits_remaining = credits_remaining + amount
  WHERE id = user_id
  RETURNING credits_remaining INTO updated_credits;

  IF updated_credits IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  RETURN updated_credits;
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_credits(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.deduct_credits(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_credits(uuid, integer) TO service_role;
