import { createClient } from '@supabase/supabase-js';

type CreateJobRequest = {
  payload?: unknown;
};

type CreateJobRpcResponse = {
  data: string | null;
  error: { message: string } | null;
};

const VIDEO_JOB_COST = 10;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  if (!supabaseUrl) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_URL');
  }

  if (!supabaseAnonKey) {
    return missingEnvResponse('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  if (!supabaseServiceRoleKey) {
    return missingEnvResponse('SUPABASE_SERVICE_ROLE_KEY');
  }

  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
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
  } = await authClient.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let requestBody: CreateJobRequest;

  try {
    requestBody = (await request.json()) as CreateJobRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isJsonObject(requestBody.payload)) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const rpcResponse = (await serviceClient.rpc('create_video_job', {
    p_user_id: user.id,
    p_cost: VIDEO_JOB_COST,
    p_payload: requestBody.payload
  })) as CreateJobRpcResponse;

  if (rpcResponse.error || !rpcResponse.data) {
    console.error('create_video_job RPC failed', {
      userId: user.id,
      message: rpcResponse.error?.message
    });

    const isInsufficientCredits =
      rpcResponse.error?.message?.toLowerCase().includes('insufficient credits') ?? false;

    if (isInsufficientCredits) {
      return Response.json({ error: 'Insufficient credits' }, { status: 402 });
    }

    return Response.json({ error: 'Unable to create job' }, { status: 400 });
  }

  return Response.json({ job_id: rpcResponse.data }, { status: 200 });
}
