# Eventflow — Tasks

> Webhook-driven task processing pipeline.
> Each task has a status: `[ ]` pending, `[x]` done, `[-]` skipped.

---

## M1: Project Foundation (Days 1–2)

### Scaffold & Tooling

- [x] 1.1 `npm init` and configure `package.json` (name, scripts, engines)
- [x] 1.2 Install dev dependencies: `typescript`, `eslint`, `prettier`, `jest`, `ts-jest`, `@types/node`
- [x] 1.3 Install runtime dependencies: `express`, `pg`, `pg-boss`, `dotenv`
- [x] 1.4 Install type packages: `@types/express`, `@types/pg`
- [x] 1.5 Create `tsconfig.json` (strict: true, outDir: dist, rootDir: src)
- [x] 1.6 Create `.eslintrc` config (TypeScript parser, no-any rule)
- [x] 1.7 Create `.prettierrc` (2-space indent, single quotes, trailing commas, semicolons)
- [x] 1.8 Add npm scripts: `dev`, `build`, `start`, `worker`, `lint`, `format`, `test`, `migrate`
- [x] 1.9 Create `src/` directory structure: `server.ts`, `worker.ts`, `routes/`, `actions/`, `services/`, `db/`, `types/`, `utils/`
- [x] 1.10 Create `tests/` directory structure: `tests/unit/`, `tests/integration/`
- [x] 1.11 Create `.gitignore` (node_modules, dist, .env, coverage)

### Docker

- [x] 1.12 Create `Dockerfile` (multi-stage: build + production, Node 20 base)
- [x] 1.13 Create `docker-compose.yml` (api, worker, postgres services)
- [x] 1.14 Create `.dockerignore`
- [x] 1.15 Verify `docker compose up --build` starts all services cleanly

### Database

- [x] 1.16 Create `.env.example` with all required/optional env vars
- [x] 1.17 Create `src/db/pool.ts` — PostgreSQL connection pool using `pg.Pool`
- [x] 1.18 Create migration runner script (`src/db/migrate.ts`)
- [x] 1.19 Migration 001: Create `pipelines` table
- [x] 1.20 Migration 002: Create `subscribers` table
- [x] 1.21 Migration 003: Create `jobs` table
- [x] 1.22 Migration 004: Create `delivery_attempts` table
- [x] 1.23 Verify migrations run successfully against Dockerized PostgreSQL

---

## M2: Pipeline CRUD API (Days 3–4)

### Server Setup

- [ ] 2.1 Create `src/server.ts` — Express app with JSON parsing, CORS, health check (`GET /health`)
- [ ] 2.2 Create `src/types/pipeline.ts` — interfaces for Pipeline, Subscriber, API request/response
- [ ] 2.3 Create `src/utils/errors.ts` — `AppError` class with `statusCode` and `isOperational`
- [ ] 2.4 Create error-handling middleware (`src/utils/errorHandler.ts`)
- [ ] 2.5 Create async route wrapper utility (`src/utils/asyncHandler.ts`)

### Pipeline Routes

- [ ] 2.6 Create `src/routes/pipelines.ts` — Express router for `/api/v1/pipelines`
- [ ] 2.7 `POST /api/v1/pipelines` — validate input, generate `source_token`, insert pipeline + subscribers, return 201
- [ ] 2.8 `GET /api/v1/pipelines` — list all pipelines with pagination (limit, offset)
- [ ] 2.9 `GET /api/v1/pipelines/:id` — get single pipeline with its subscribers, return 404 if missing
- [ ] 2.10 `PATCH /api/v1/pipelines/:id` — partial update (name, description, action_type, action_config, is_active)
- [ ] 2.11 `DELETE /api/v1/pipelines/:id` — delete pipeline (cascades to subscribers), return 204
- [ ] 2.12 Input validation for create/update (required fields, valid action_type values)

### Tests

- [ ] 2.13 Unit tests for pipeline validation logic
- [ ] 2.14 Integration tests for all pipeline CRUD endpoints

---

## M3: Webhook Ingestion & Job Queue (Days 5–6)

### pg-boss Setup

- [ ] 3.1 Create `src/services/queue.ts` — pg-boss instance initialization and helpers (enqueue, start, stop)
- [ ] 3.2 Initialize pg-boss on server startup, graceful shutdown on SIGTERM

### Webhook Endpoint

- [ ] 3.3 Create `src/routes/webhooks.ts` — Express router for `/webhooks/:sourceToken`
- [ ] 3.4 `POST /webhooks/:sourceToken` — look up pipeline by source_token, reject if not found or inactive (404)
- [ ] 3.5 Insert job row (status: pending, payload from request body)
- [ ] 3.6 Enqueue job to pg-boss queue
- [ ] 3.7 Return 202 with `job_id`, `status: "queued"`, confirmation message

### Tests

- [ ] 3.8 Unit tests for webhook validation (missing pipeline, inactive pipeline)
- [ ] 3.9 Integration tests for webhook ingestion + job creation

---

## M4: Worker & Processing Actions (Days 7–8)

### Processing Actions

- [ ] 4.1 Create `src/actions/transformJson.ts` — field remapping using JSONPath-style dot notation
- [ ] 4.2 Create `src/actions/filterFields.ts` — allowlist/blocklist field filtering
- [ ] 4.3 Create `src/actions/enrichTimestamp.ts` — add `_meta` block with pipeline info + timestamp
- [ ] 4.4 Create `src/actions/index.ts` — action registry/dispatcher that maps `action_type` string to handler
- [ ] 4.5 Define `ActionHandler` interface: `(payload, config, pipelineContext) => result`

### Worker

- [ ] 4.6 Create `src/worker.ts` — entry point: connect pg-boss, register job handler, graceful shutdown
- [ ] 4.7 Implement job handler: fetch pipeline, run action, update job status (processing → completed/failed)
- [ ] 4.8 Store `result` on success, `error_message` on failure
- [ ] 4.9 Configure concurrency via `WORKER_CONCURRENCY` env var (default: 3)
- [ ] 4.10 Verify worker picks up and processes jobs end-to-end

### Tests

- [ ] 4.11 Unit tests for `transform_json` action (mapping, nested paths, missing keys)
- [ ] 4.12 Unit tests for `filter_fields` action (allowlist mode, blocklist mode)
- [ ] 4.13 Unit tests for `enrich_timestamp` action (meta block structure)
- [ ] 4.14 Unit tests for action dispatcher (unknown action_type error)
- [ ] 4.15 Integration test: webhook → queue → worker → job completed

---

## M5: Delivery & Retry Logic (Day 9)

### Delivery Service

- [ ] 5.1 Create `src/services/delivery.ts` — POST result to subscriber URL with custom headers
- [ ] 5.2 Set 10s timeout per HTTP request
- [ ] 5.3 Record each attempt in `delivery_attempts` table (status_code, success, response_body, attempt_number)
- [ ] 5.4 Treat any 2xx response as success

### Retry Mechanism

- [ ] 5.5 Implement exponential backoff schedule (30s, 2m, 10m, 30m, 2h)
- [ ] 5.6 Schedule retry via pg-boss delayed jobs on failure
- [ ] 5.7 Mark delivery permanently failed after 5 attempts
- [ ] 5.8 Integrate delivery into worker job handler (deliver to all subscribers after action runs)

### Tests

- [ ] 5.9 Unit tests for delivery service (success, failure, timeout)
- [ ] 5.10 Unit tests for retry backoff schedule calculation
- [ ] 5.11 Integration test: failed delivery triggers retry

---

## M6: Observability API (Day 10)

### Job Routes

- [ ] 6.1 Create `src/routes/jobs.ts` — Express router for `/api/v1/jobs`
- [ ] 6.2 `GET /api/v1/jobs/:id` — return job with status, payload, result, timestamps
- [ ] 6.3 `GET /api/v1/jobs` — list jobs with query filters: `pipeline_id`, `status`, `limit`, `offset`
- [ ] 6.4 `GET /api/v1/jobs/:id/deliveries` — return delivery attempts for a job (with subscriber URL)

### Tests

- [ ] 6.5 Integration tests for job status endpoint
- [ ] 6.6 Integration tests for job listing with filters
- [ ] 6.7 Integration tests for delivery history endpoint

---

## M7: CI/CD & Polish (Days 11–12)

### GitHub Actions

- [ ] 7.1 Create `.github/workflows/ci.yml` — triggers on push to main + all PRs
- [ ] 7.2 CI job: lint (`npm run lint`)
- [ ] 7.3 CI job: typecheck (`npx tsc --noEmit`)
- [ ] 7.4 CI job: test (`npm test`) with PostgreSQL service container
- [ ] 7.5 CI job: Docker build verification (`docker build`)
- [ ] 7.6 CD job: deploy to Cloud Run on merge to main (using `gcloud` CLI)

### Cleanup

- [ ] 7.7 Review and fix all lint/type errors
- [ ] 7.8 Ensure all tests pass
- [ ] 7.9 Update README with setup instructions, API docs, architecture diagram
- [ ] 7.10 Verify `docker compose up --build` works end-to-end from clean state

---

## M8: Stretch Goals (Days 13–14)

- [ ] 8.1 Webhook signature verification — validate `X-Hub-Signature-256` HMAC header
- [ ] 8.2 API key authentication — protect CRUD endpoints with `Authorization: Bearer <key>`
- [ ] 8.3 Rate limiting — per-pipeline webhook rate limits
- [ ] 8.4 Pipeline chaining — pipeline output triggers another pipeline
- [ ] 8.5 Metrics endpoint — `GET /metrics` with job counts, delivery success rates
- [ ] 8.6 Dead letter queue — permanently failed jobs moved to DLQ
