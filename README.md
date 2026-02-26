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

## Quick start

```bash
npm install
npm run build
```

Run web app locally:

```bash
npm run dev:web
```
