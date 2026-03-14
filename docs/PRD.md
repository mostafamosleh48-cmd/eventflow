# Product Requirements Document (PRD)
## Webhook-Driven Task Processing Pipeline
**Version:** 1.0  
**Author:** [Your Name]  
**Timeline:** 1–2 Weeks  
**Stack:** TypeScript · PostgreSQL · Docker · GitHub Actions

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Goals & Success Criteria](#2-goals--success-criteria)
3. [System Architecture](#3-system-architecture)
4. [Data Models & Schema](#4-data-models--schema)
5. [API Specification](#5-api-specification)
6. [Processing Actions](#6-processing-actions)
7. [Job Queue & Worker](#7-job-queue--worker)
8. [Delivery & Retry Logic](#8-delivery--retry-logic)
9. [Infrastructure](#9-infrastructure)
10. [CI/CD Pipeline](#10-cicd-pipeline)
11. [Stretch Goals](#11-stretch-goals)
12. [Skills Reference](#12-skills-reference)
    - [Skill: Deploy to Cloud Run (gcloud CLI)](#skill-deploy-to-cloud-run-gcloud-cli)
    - [Skill: Push Commits to GitHub](#skill-push-commits-to-github)
13. [Timeline & Milestones](#13-timeline--milestones)
14. [Open Questions & Design Decisions](#14-open-questions--design-decisions)

---

## 1. Project Overview

Build a simplified **Zapier-like** webhook processing service. The service allows users to create **pipelines** that:

1. Accept incoming webhooks via a unique source URL
2. Apply a configurable **processing action** to the payload
3. Deliver the processed result to one or more **subscriber URLs**

All processing is **asynchronous** — incoming webhooks are immediately queued as jobs and processed in the background by a worker.

---

## 2. Goals & Success Criteria

| Goal | Success Metric |
|------|---------------|
| Reliable webhook ingestion | Webhook receives `202 Accepted` within 100ms |
| Background job processing | Worker picks up job within 5s of queuing |
| Delivery with retries | Failed deliveries retried up to 5× with backoff |
| Full CRUD for pipelines | All endpoints return correct HTTP status codes |
| Job observability | Job status and delivery history queryable via API |
| Docker-first setup | `docker compose up` runs with zero manual steps |
| CI passes | GitHub Actions runs lint + build + tests on every push |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Docker Network                   │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐   ┌─────────────┐ │
│  │  API Server │───▶│  PostgreSQL  │◀──│   Worker    │ │
│  │ (Express/TS)│    │   (jobs +    │   │  (BullMQ /  │ │
│  └──────┬──────┘    │  pipelines)  │   │  pg-boss)   │ │
│         │           └──────────────┘   └──────┬──────┘ │
│         │                                      │        │
│         ▼                                      ▼        │
│  ┌─────────────┐                    ┌─────────────────┐ │
│  │  Redis (opt)│                    │  Subscriber URLs│ │
│  │  Job Queue  │                    │  (HTTP POST)    │ │
│  └─────────────┘                    └─────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Components

| Component | Responsibility |
|-----------|---------------|
| **API Server** | CRUD for pipelines, webhook ingestion, job status queries |
| **Job Queue** | Stores pending/active/failed jobs (PostgreSQL or Redis/BullMQ) |
| **Worker** | Polls queue, runs processing actions, delivers results |
| **PostgreSQL** | Persistent store for pipelines, jobs, delivery attempts |

### Request Lifecycle

```
Webhook POST /webhooks/:pipelineId
        │
        ▼
  Validate pipeline exists
        │
        ▼
  Insert job → queue (status: pending)
        │
        ▼
  Return 202 Accepted + jobId
        │
        ▼  (async)
  Worker picks up job
        │
        ▼
  Run processing action on payload
        │
        ▼
  POST result to each subscriber URL
        │
        ▼
  Record delivery attempt (success/fail)
        │
        ▼
  Retry on failure (exponential backoff)
```

---

## 4. Data Models & Schema

### `pipelines`

```sql
CREATE TABLE pipelines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  source_token  TEXT UNIQUE NOT NULL,       -- unique path token for /webhooks/:token
  action_type   TEXT NOT NULL,              -- 'transform_json' | 'filter_fields' | 'enrich_timestamp' | ...
  action_config JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `subscribers`

```sql
CREATE TABLE subscribers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  headers     JSONB NOT NULL DEFAULT '{}',  -- optional custom headers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `jobs`

```sql
CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id   UUID NOT NULL REFERENCES pipelines(id),
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
  payload       JSONB NOT NULL,
  result        JSONB,
  error_message TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
```

### `delivery_attempts`

```sql
CREATE TABLE delivery_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  subscriber_id UUID NOT NULL REFERENCES subscribers(id),
  status_code   INT,
  success       BOOLEAN NOT NULL,
  response_body TEXT,
  attempt_number INT NOT NULL DEFAULT 1,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 5. API Specification

### Base URL
```
http://localhost:3000/api/v1
```

---

### Pipelines

#### `POST /pipelines` — Create pipeline
**Request body:**
```json
{
  "name": "My Pipeline",
  "description": "Optional description",
  "action_type": "transform_json",
  "action_config": { "template": "..." },
  "subscribers": [
    { "url": "https://example.com/hook", "headers": { "Authorization": "Bearer xyz" } }
  ]
}
```
**Response `201`:**
```json
{
  "id": "uuid",
  "source_url": "http://localhost:3000/webhooks/abc123token",
  "name": "My Pipeline",
  "action_type": "transform_json",
  "subscribers": [...]
}
```

#### `GET /pipelines` — List all pipelines
**Response `200`:** Array of pipeline objects.

#### `GET /pipelines/:id` — Get pipeline by ID
**Response `200`:** Single pipeline with subscribers.

#### `PATCH /pipelines/:id` — Update pipeline
**Response `200`:** Updated pipeline object.

#### `DELETE /pipelines/:id` — Delete pipeline
**Response `204`:** No content.

---

### Webhooks (Ingestion)

#### `POST /webhooks/:sourceToken`
Accepts any JSON payload. Queues a job for background processing.

**Response `202`:**
```json
{
  "job_id": "uuid",
  "status": "queued",
  "message": "Webhook received and queued for processing"
}
```

**Response `404`:** Pipeline not found or inactive.

---

### Jobs

#### `GET /jobs/:id` — Get job status
**Response `200`:**
```json
{
  "id": "uuid",
  "pipeline_id": "uuid",
  "status": "completed",
  "payload": { ... },
  "result": { ... },
  "attempts": 1,
  "created_at": "...",
  "completed_at": "..."
}
```

#### `GET /jobs?pipeline_id=:id&status=:status&limit=50` — List jobs
Query params: `pipeline_id`, `status`, `limit`, `offset`.

#### `GET /jobs/:id/deliveries` — Get delivery attempts for a job
**Response `200`:** Array of delivery attempt objects including subscriber URL, status code, success, and timestamp.

---

## 6. Processing Actions

Implement **at least three** of the following action types. Each action receives the raw webhook payload and returns a transformed result.

### 1. `transform_json` — Field Remapping
Remap, rename, or restructure JSON keys using a config-driven mapping.

**Config:**
```json
{
  "mapping": {
    "user_name": "$.data.name",
    "email": "$.data.contact.email"
  }
}
```
**Input:** `{ "data": { "name": "Alice", "contact": { "email": "alice@example.com" } } }`  
**Output:** `{ "user_name": "Alice", "email": "alice@example.com" }`

---

### 2. `filter_fields` — Field Allowlist/Blocklist
Keep only allowed fields or remove blocked fields from the payload.

**Config:**
```json
{
  "mode": "allowlist",
  "fields": ["id", "name", "email"]
}
```
**Input:** `{ "id": 1, "name": "Alice", "password": "secret", "email": "a@b.com" }`  
**Output:** `{ "id": 1, "name": "Alice", "email": "a@b.com" }`

---

### 3. `enrich_timestamp` — Metadata Enrichment
Adds pipeline metadata and timing information to the payload.

**Config:** `{}` (no config needed)

**Output adds:**
```json
{
  "_meta": {
    "pipeline_id": "uuid",
    "pipeline_name": "My Pipeline",
    "processed_at": "2025-01-01T12:00:00Z",
    "source": "webhook"
  }
}
```

---

### 4. `http_fetch` *(stretch)* — External Enrichment
Calls an external URL and merges the response into the payload.

**Config:**
```json
{
  "url": "https://api.example.com/enrich",
  "merge_key": "enriched"
}
```

---

### 5. `jq_transform` *(stretch)* — jq-style Transformation
Apply a jq-compatible expression to the payload.

**Config:**
```json
{ "expression": ".items[] | select(.active == true)" }
```

---

## 7. Job Queue & Worker

### Queue Strategy
Use **pg-boss** (PostgreSQL-native job queue) to avoid a Redis dependency in the core setup. Optionally swap for **BullMQ + Redis** for higher throughput.

### Worker Behavior

```
loop:
  job = queue.dequeue()
  if job:
    mark job as "processing"
    result = run_action(job.payload, pipeline.action_config)
    for each subscriber:
      deliver(result, subscriber)
    mark job as "completed" or "failed"
  else:
    sleep(1s)
```

### Concurrency
- Default: **3 concurrent workers**
- Configurable via `WORKER_CONCURRENCY` env var

### Error Handling
- If action throws: mark job `failed`, store `error_message`
- If all deliveries fail: job still marked `completed` (delivery failures tracked separately)

---

## 8. Delivery & Retry Logic

### Delivery
Each subscriber receives a `POST` request with:
- **Body:** JSON-serialized processed result
- **Headers:** `Content-Type: application/json` + any subscriber-defined custom headers
- **Timeout:** 10 seconds per request

### Retry Policy

| Attempt | Delay |
|---------|-------|
| 1st retry | 30s |
| 2nd retry | 2m |
| 3rd retry | 10m |
| 4th retry | 30m |
| 5th retry | 2h |

After 5 failed attempts, delivery is marked **permanently failed**.

### Success Criteria
HTTP response with status code `2xx` is considered a success.

---

## 9. Infrastructure

### `docker-compose.yml` Services

| Service | Image | Port |
|---------|-------|------|
| `api` | Custom Node.js image | 3000 |
| `worker` | Same image, different CMD | — |
| `postgres` | `postgres:16-alpine` | 5432 |
| `redis` *(optional)* | `redis:7-alpine` | 6379 |

### Environment Variables

```env
# App
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgresql://user:pass@postgres:5432/pipeline_db

# Worker
WORKER_CONCURRENCY=3
JOB_MAX_RETRIES=5

# Optional
REDIS_URL=redis://redis:6379
```

### Docker Commands

```bash
# Start all services
docker compose up --build

# Run migrations
docker compose exec api npm run migrate

# View worker logs
docker compose logs -f worker

# Stop all services
docker compose down

# Full reset (drop volumes)
docker compose down -v
```

---

## 10. CI/CD Pipeline

### GitHub Actions Workflow (`.github/workflows/ci.yml`)

**Triggers:** Push to `main`, all Pull Requests

**Jobs:**
1. **lint** — ESLint + Prettier check
2. **typecheck** — `tsc --noEmit`
3. **test** — Jest unit + integration tests (with PostgreSQL service container)
4. **build** — `docker build` to verify image builds
5. **deploy** *(on merge to main)* — Deploy to Cloud Run via gcloud CLI

---

## 11. Stretch Goals

Prioritize a solid core before attempting these.

| Feature | Description |
|---------|-------------|
| **Webhook Signature Verification** | Verify `X-Hub-Signature-256` HMAC header on inbound webhooks |
| **API Key Authentication** | Protect CRUD endpoints with `Authorization: Bearer <key>` |
| **Rate Limiting** | Limit inbound webhooks per pipeline per minute |
| **Pipeline Chaining** | A pipeline's output can trigger another pipeline |
| **Dashboard UI** | Simple React/HTML UI to manage pipelines and monitor jobs |
| **Metrics Endpoint** | `GET /metrics` — job counts, delivery success rates, avg processing time |
| **Dead Letter Queue** | Permanently failed jobs moved to DLQ for manual inspection |
| **Concurrency Control** | Per-pipeline concurrency limits |

---

## 12. Skills Reference

---

### Skill: Deploy to Cloud Run (gcloud CLI)

> Use this skill when you need to deploy or update the service on **Google Cloud Run** using the `gcloud` CLI.

#### Prerequisites

```bash
# Install gcloud CLI (if not installed)
curl https://sdk.cloud.google.com | bash
exec -l $SHELL

# Authenticate
gcloud auth login

# Set project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable run.googleapis.com \
  containerregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

#### Commands

##### Build & Push Docker Image to Artifact Registry

```bash
# Configure Docker for gcloud
gcloud auth configure-docker REGION-docker.pkg.dev

# Build the image
docker build -t REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/pipeline-api:latest .

# Push the image
docker push REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/pipeline-api:latest
```

##### Deploy to Cloud Run

```bash
# Deploy the API service
gcloud run deploy pipeline-api \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/pipeline-api:latest \
  --region REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 3000 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars NODE_ENV=production \
  --set-secrets DATABASE_URL=DATABASE_URL:latest

# Deploy the Worker service (same image, different command)
gcloud run deploy pipeline-worker \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPO_NAME/pipeline-api:latest \
  --region REGION \
  --platform managed \
  --no-allow-unauthenticated \
  --command "node" \
  --args "dist/worker.js" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 5 \
  --set-secrets DATABASE_URL=DATABASE_URL:latest
```

##### Store Secrets in Secret Manager

```bash
# Create a secret
echo -n "postgresql://user:pass@host:5432/db" | \
  gcloud secrets create DATABASE_URL --data-file=-

# Update a secret
echo -n "new-value" | \
  gcloud secrets versions add DATABASE_URL --data-file=-

# Grant Cloud Run service account access to secrets
gcloud secrets add-iam-policy-binding DATABASE_URL \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

##### Useful Inspection Commands

```bash
# List deployed services
gcloud run services list --region REGION

# Get service URL
gcloud run services describe pipeline-api \
  --region REGION \
  --format 'value(status.url)'

# View logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=pipeline-api" \
  --limit 50 \
  --format "table(timestamp,textPayload)"

# View recent revisions
gcloud run revisions list --service pipeline-api --region REGION

# Roll back to a previous revision
gcloud run services update-traffic pipeline-api \
  --to-revisions REVISION_NAME=100 \
  --region REGION
```

##### CI/CD Integration — GitHub Actions Step

```yaml
- name: Deploy to Cloud Run
  uses: google-github-actions/deploy-cloudrun@v2
  with:
    service: pipeline-api
    image: ${{ env.IMAGE_TAG }}
    region: us-central1
```

Or using raw gcloud CLI in a workflow:

```yaml
- name: Authenticate to Google Cloud
  uses: google-github-actions/auth@v2
  with:
    credentials_json: ${{ secrets.GCP_SA_KEY }}

- name: Deploy API to Cloud Run
  run: |
    gcloud run deploy pipeline-api \
      --image $IMAGE_TAG \
      --region us-central1 \
      --platform managed \
      --allow-unauthenticated
```

---

### Skill: Push Commits to GitHub

> Use this skill to stage, commit, and push code changes to a GitHub repository from the CLI.

#### Initial Setup (one-time)

```bash
# Configure identity
git config --global user.name "Your Name"
git config --global user.email "you@example.com"

# Authenticate with GitHub CLI (recommended)
gh auth login

# OR: Set up SSH key
ssh-keygen -t ed25519 -C "you@example.com"
cat ~/.ssh/id_ed25519.pub   # paste into GitHub Settings > SSH Keys

# Clone the repo (if not already cloned)
git clone git@github.com:USERNAME/REPO_NAME.git
cd REPO_NAME
```

#### Standard Commit & Push Workflow

```bash
# Check what changed
git status
git diff

# Stage specific files
git add src/worker.ts src/actions/transform.ts

# Stage all changes (tracked + untracked)
git add .

# Commit with a descriptive message (use Conventional Commits format)
git commit -m "feat: add transform_json processing action"

# Push to current branch
git push

# Push to a specific remote/branch
git push origin main
```

#### Branch Workflow (recommended)

```bash
# Create and switch to a feature branch
git checkout -b feat/add-retry-logic

# ... make changes ...

git add .
git commit -m "feat: implement exponential backoff retry for deliveries"

# Push the new branch to remote
git push -u origin feat/add-retry-logic

# Open a Pull Request via GitHub CLI
gh pr create \
  --title "feat: add retry logic for failed deliveries" \
  --body "Implements exponential backoff with up to 5 retry attempts." \
  --base main \
  --head feat/add-retry-logic
```

#### Conventional Commit Message Types

```
feat:     new feature
fix:      bug fix
docs:     documentation changes
refactor: code restructuring (no behavior change)
test:     adding or fixing tests
chore:    tooling, deps, CI changes
perf:     performance improvement
build:    Docker, CI, build system changes
```

#### Useful Git Commands

```bash
# View commit history (clean graph)
git log --oneline --graph --all

# Amend the last commit message (before push)
git commit --amend -m "fix: correct typo in delivery retry logic"

# Undo last commit (keep changes staged)
git reset --soft HEAD~1

# Stash current changes temporarily
git stash
git stash pop

# Pull latest changes from remote
git pull origin main

# Check remote URL
git remote -v

# Tag a release
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0
```

#### Merging a PR & Cleaning Up

```bash
# Merge PR via GitHub CLI
gh pr merge feat/add-retry-logic --squash --delete-branch

# Switch back to main and pull
git checkout main
git pull

# Delete local branch
git branch -d feat/add-retry-logic
```

---

## 13. Timeline & Milestones

| Day | Milestone |
|-----|-----------|
| 1–2 | Project scaffold, Docker Compose, PostgreSQL schema, migrations |
| 3–4 | CRUD API for pipelines and subscribers |
| 5–6 | Webhook ingestion endpoint + job queue (pg-boss) |
| 7–8 | Worker implementation + 3 processing actions |
| 9 | Delivery logic + retry mechanism |
| 10 | Job status / delivery history API |
| 11 | GitHub Actions CI pipeline |
| 12 | README, cleanup, recording demo video |
| 13–14 | Stretch goals (auth, signature verification, dashboard) |

---

## 14. Open Questions & Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Queue backend: Redis or PostgreSQL? | pg-boss (PostgreSQL) as default | Reduces infra complexity; no Redis required for core setup |
| Worker: separate process or same container? | Separate `worker` service in Docker Compose | Clear separation of concerns; independently scalable |
| Job retry vs delivery retry? | Two separate retry mechanisms | Job-level retries (action failures) are distinct from delivery-level retries (subscriber HTTP failures) |
| Synchronous or async action execution? | Always async | Prevents slow subscribers from blocking the ingestion endpoint |
| Webhook payload validation? | Accept any valid JSON | Pipelines should be flexible; validation is the action's responsibility |
| Source URL format? | `/webhooks/:sourceToken` (opaque token) | Avoids exposing internal UUIDs; tokens are rotatable |