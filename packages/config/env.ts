export type RequiredEnvKey =
  | 'NEXT_PUBLIC_SUPABASE_URL'
  | 'NEXT_PUBLIC_SUPABASE_ANON_KEY'
  | 'SUPABASE_SERVICE_ROLE_KEY'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'ADMIN_SECRET'
  | 'CLOUDFLARE_QUEUE';

const SECRET_HINTS = ['SECRET', 'TOKEN', 'KEY', 'PASSWORD', 'WEBHOOK'];

function isBlank(value: string | undefined): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

export function getRequiredEnv(key: RequiredEnvKey, env: Record<string, string | undefined> = process.env): string {
  const value = env[key];
  if (isBlank(value)) {
    throw new Error(`[env] Missing required environment variable: ${key}`);
  }

  return value as string;
}

export function validateRequiredEnv(keys: readonly RequiredEnvKey[], env: Record<string, string | undefined> = process.env): void {
  const missing = keys.filter((key) => isBlank(env[key]));
  if (missing.length > 0) {
    throw new Error(`[env] Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function redactEnvValue(key: string, value: string | undefined): string {
  if (!value) {
    return '[missing]';
  }

  if (SECRET_HINTS.some((hint) => key.toUpperCase().includes(hint))) {
    return '[redacted]';
  }

  return value as string;
}
