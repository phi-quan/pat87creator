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

  INSERT INTO public.jobs (video_id)
  SELECT v.id
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

REVOKE ALL ON FUNCTION public.create_video_job(uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_video_job(uuid, integer, jsonb) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.create_video_job(uuid, integer, jsonb) TO service_role;
