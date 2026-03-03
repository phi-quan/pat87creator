import { createClient } from '@supabase/supabase-js';

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type ResultPayload = {
  artifact_path?: string;
  artifact_url?: string;
  url?: string;
  video_url?: string;
};

type JobRow = {
  id: string;
  status: JobStatus;
  created_at: string;
  error_message: string | null;
  result_payload: ResultPayload | null;
};

type JobListItem = {
  id: string;
  status: JobStatus;
  created_at: string;
  video_url: string | null;
  error_message: string | null;
};

type JobsResponse = {
  total: number;
  page: number;
  limit: number;
  data: JobListItem[];
};

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_ARTIFACT_BUCKET = 'videos';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const artifactBucket = process.env.SUPABASE_ARTIFACT_BUCKET ?? DEFAULT_ARTIFACT_BUCKET;

function missingEnvResponse(name: string) {
  return Response.json(
    { error: `Missing required environment variable: ${name}` },
    { status: 500 }
  );
}

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.get('authorization');
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim() || null;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStatus(value: string | null): JobStatus | null {
  if (!value) {
    return null;
  }

  if (value === 'queued' || value === 'processing' || value === 'completed' || value === 'failed') {
    return value;
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInternalErrorMessage(errorMessage: string | null): string {
  if (!errorMessage) {
    return '';
  }

  return errorMessage.toLowerCase();
}

function mapToSafeErrorMessage(errorMessage: string | null): string | null {
  const normalized = normalizeInternalErrorMessage(errorMessage);

  if (!normalized) {
    return null;
  }

  if (normalized.includes('timeout')) {
    return 'Processing timeout. Please retry.';
  }

  if (normalized.includes('ffmpeg')) {
    return 'Video processing failed.';
  }

  if (normalized.includes('queue')) {
    return 'Temporary system issue. Please retry.';
  }

  return 'Video processing failed. Please retry.';
}

function extractArtifactPath(payload: ResultPayload | null): string | null {
  if (!payload || !isObject(payload)) {
    return null;
  }

  if (typeof payload.artifact_url === 'string' && payload.artifact_url.length > 0) {
    return payload.artifact_url;
  }

  if (typeof payload.video_url === 'string' && payload.video_url.length > 0) {
    return payload.video_url;
  }

  if (typeof payload.url === 'string' && payload.url.length > 0) {
    return payload.url;
  }

  if (typeof payload.artifact_path === 'string' && payload.artifact_path.length > 0) {
    return payload.artifact_path;
  }

  return null;
}

type StoragePublicUrlClient = {
  storage: {
    from: (bucket: string) => {
      getPublicUrl: (path: string) => { data: { publicUrl: string } };
    };
  };
};

function toVideoUrl(client: StoragePublicUrlClient, job: JobRow): string | null {
  if (job.status !== 'completed') {
    return null;
  }

  const artifactValue = extractArtifactPath(job.result_payload);

  if (!artifactValue) {
    return null;
  }

  if (artifactValue.startsWith('http://') || artifactValue.startsWith('https://')) {
    return artifactValue;
  }

  const { data } = client.storage.from(artifactBucket).getPublicUrl(artifactValue);

  return data.publicUrl ?? null;
}

export async function GET(request: Request) {
  if (!supabaseUrl) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_URL');
  }

  if (!supabaseAnonKey) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  const {
    data: { user },
    error: userError
  } = await client.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const page = parsePositiveInt(url.searchParams.get('page'), DEFAULT_PAGE);
  const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
  const status = parseStatus(url.searchParams.get('status'));

  if (url.searchParams.get('status') && !status) {
    return Response.json({ error: 'Invalid status filter' }, { status: 400 });
  }

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = client
    .from('jobs')
    .select('id, status, created_at, error_message, result_payload, videos!inner(user_id)', {
      count: 'exact'
    })
    .eq('videos.user_id', user.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) {
    query = query.eq('status', status);
  }

  const { data, count, error } = await query.returns<(JobRow & { videos: { user_id: string } })[]>();

  if (error) {
    console.error('Failed to fetch jobs', {
      userId: user.id,
      message: error.message
    });

    return Response.json({ error: 'Failed to fetch jobs' }, { status: 500 });
  }

  const jobs = (data ?? []).map(({ id, status: jobStatus, created_at, error_message, result_payload }) => ({
    id,
    status: jobStatus,
    created_at,
    video_url: toVideoUrl(client, {
      id,
      status: jobStatus,
      created_at,
      error_message,
      result_payload
    }),
    error_message: jobStatus === 'failed' ? mapToSafeErrorMessage(error_message) : null
  }));

  const payload: JobsResponse = {
    total: count ?? 0,
    page,
    limit,
    data: jobs
  };

  return Response.json(payload, { status: 200 });
}
