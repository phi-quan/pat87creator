# pat87creator

Minimal npm-workspaces monorepo scaffold for the MVP.

## Structure

- `apps/web` - Next.js 14 + TypeScript web app
- `apps/worker-api` - Cloudflare Worker API
- `apps/worker-consumer` - Cloudflare Queue consumer stub
- `packages/shared` - shared types/constants
- `packages/db` - database client/schema stubs

## Requirements

- Node.js 18+
- npm 9+

## Environment setup

Copy `.env.example` to `.env.local` and set values for local development.

Required Supabase variables for `apps/web` auth flow:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Required Stripe webhook variables for `apps/web/app/api/stripe/webhook`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Quick start

```bash
npm install
npm run build
```

Run web app locally:

```bash
npm run dev:web
```


## Cloudflare Pages configuration

For production deployment of the web app, configure Cloudflare Pages with the Cloudflare Next.js adapter enabled in the build step:

- Root directory: `apps/web`
- Build command: `npm run build`
- Output directory: `.vercel/output/static`

Required environment variables in Cloudflare Pages:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Deploy update
