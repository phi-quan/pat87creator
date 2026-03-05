ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS storage_url text,
  ADD COLUMN IF NOT EXISTS duration numeric;

CREATE INDEX IF NOT EXISTS idx_videos_job_storage_url
  ON public.videos (storage_url)
  WHERE storage_url IS NOT NULL;
