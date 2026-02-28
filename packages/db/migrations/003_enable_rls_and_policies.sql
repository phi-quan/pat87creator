ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_own
  ON public.users
  FOR SELECT
  USING (id = auth.uid());

CREATE POLICY users_update_own
  ON public.users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY videos_select_own
  ON public.videos
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY videos_insert_own
  ON public.videos
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY videos_update_own
  ON public.videos
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY payments_select_own
  ON public.payments
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY jobs_select_own
  ON public.jobs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.videos
      WHERE videos.id = jobs.video_id
        AND videos.user_id = auth.uid()
    )
  );
