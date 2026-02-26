# pat87creator - Architecture (MVP 30 Days)

## 1. Product Overview

AI Video Automation SaaS

Target:
- US market
- YouTube Shorts creators
- Faceless content automation

MVP Objective:
Launch in 30 days with minimal but scalable architecture.

---

## 2. Tech Stack

Frontend:
- Next.js (PWA)
- Cloudflare Pages

API Layer:
- Cloudflare Workers

Database & Auth:
- Supabase (PostgreSQL + Auth)

Queue:
- Cloudflare Queue
  - pat87-short-high (Premium)
  - pat87-short-normal (Free)

Orchestration:
- n8n (local for MVP)

Rendering:
- FFmpeg (CPU-based)
- Coqui TTS
- GPT (script generation)

Storage:
- Cloudflare R2 (private bucket)

Payment:
- PayPal Subscription

---

## 3. System Flow

User
→ PWA
→ Worker API
→ Supabase (Auth + Quota Check)
→ Cloudflare Queue (Priority-based)
→ Queue Consumer Worker
→ n8n Webhook
→ Render (FFmpeg + TTS)
→ Upload to R2
→ Callback Worker
→ Update Database
→ User Notification

---

## 4. Database Entities

Users
- id
- email
- plan_type (free / premium)
- short_quota_remaining
- subscription_status
- created_at

Videos
- id
- user_id
- type (short)
- topic
- subtopic
- template
- language
- status (queued / processing / completed / failed)
- r2_url
- error_message
- created_at
- completed_at

Jobs
- id
- video_id
- priority (high / normal)
- status
- retry_count
- created_at

Payments
- id
- user_id
- paypal_transaction_id
- amount
- status
- next_billing_date

---

## 5. Concurrency Model (MVP)

Render Environment:
- Local machine (4 CPU / 8GB RAM)

Limits:
- Max 2 short jobs concurrently
- Long video disabled for MVP

Queue Strategy:
- Premium users → high priority queue
- Free users → normal queue
- High queue always processed first

---

## 6. Failure Handling

- Max render time: 10 minutes
- Retry limit: 2 attempts
- If fail → mark video as failed
- Log error in database

---

## 7. Security

- JWT validation on Worker API
- Webhook secret verification
- R2 private bucket
- Signed download URLs
- Rate limit: 5 requests/min/user

---

## 8. Environment Strategy

MVP:
- n8n + Render local machine

Phase 2:
- Move render to dedicated VPS
- Multi-node render scaling
- Load balancing

---

## 9. MVP Scope

Included:
- Short video only
- English only
- Download only
- Free + Premium plan
- Priority queue for Premium

Excluded:
- Long video
- Social auto upload
- Multi-language
- Analytics dashboard
- Template marketplace
