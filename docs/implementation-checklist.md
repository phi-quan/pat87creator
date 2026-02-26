# pat87creator - Implementation Checklist (MVP 30 Days)

This document converts the architecture into executable tasks.

---

# PHASE 1 – Foundation (Week 1)

## Project Structure

- [ ] Create monorepo structure
- [ ] Setup Next.js PWA (apps/web)
- [ ] Setup Cloudflare Worker project (apps/worker-api)
- [ ] Setup shared packages (packages/types, packages/db)
- [ ] Configure TypeScript globally

## Supabase

- [ ] Create Supabase project
- [ ] Create database schema
- [ ] Setup environment variables
- [ ] Implement Auth (signup/login/logout)

---

# PHASE 2 – Core Generate Flow (Week 2)

## API Layer

- [ ] Create POST /api/generate-short
- [ ] Implement JWT validation
- [ ] Implement quota check
- [ ] Insert video record
- [ ] Insert job record

## Queue System

- [ ] Create Cloudflare Queue (high)
- [ ] Create Cloudflare Queue (normal)
- [ ] Implement queue producer
- [ ] Implement queue consumer
- [ ] Implement priority logic

---

# PHASE 3 – Render Pipeline (Week 3)

## n8n

- [ ] Create webhook trigger
- [ ] GPT script generation node
- [ ] Coqui TTS integration
- [ ] FFmpeg render script
- [ ] Upload to R2
- [ ] Callback to Worker

## Worker Callback

- [ ] Verify webhook secret
- [ ] Update video status
- [ ] Store R2 URL
- [ ] Handle failure state

---

# PHASE 4 – UI & Payment (Week 4)

## Frontend

- [ ] Generate page
- [ ] My Videos page
- [ ] Status tracking UI
- [ ] Signed download link

## Payment

- [ ] PayPal subscription setup
- [ ] Webhook verification
- [ ] Update plan_type
- [ ] Reset quota monthly

---

# PHASE 5 – Testing & Deployment

- [ ] Deploy PWA (Cloudflare Pages)
- [ ] Deploy Worker
- [ ] Setup R2 bucket
- [ ] Setup Queue bindings
- [ ] End-to-end test (full pipeline)
- [ ] Test concurrency limits
- [ ] Test Premium priority
