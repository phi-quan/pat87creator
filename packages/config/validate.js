const required = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ADMIN_SECRET',
  'CLOUDFLARE_QUEUE'
];

const missing = required.filter((key) => {
  const value = process.env[key];
  return typeof value !== 'string' || value.trim().length === 0;
});

if (missing.length > 0) {
  console.error(`[validate:env] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('[validate:env] OK');
