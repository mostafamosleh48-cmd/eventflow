---
name: gcp-multi-service-deploy
description: Deploy production multi-service Docker Compose backends (api + worker + postgres) to Google Cloud with gcloud only. Use this whenever users mention docker-compose to Cloud Run migration, separate API/worker deployment, Cloud SQL PostgreSQL setup, Artifact Registry image publishing, service-by-service redeploys, or cleanup of GCP resources.
---

# GCP Multi-Service Deploy (Cloud Run + Cloud SQL)

Use this skill to migrate a local `docker-compose` backend to a cloud-native GCP deployment.

Target architecture:

- API container -> Cloud Run service (public)
- Worker container -> Cloud Run service (private)
- PostgreSQL container -> Cloud SQL for PostgreSQL
- Images -> Artifact Registry

## Required Behavior

- Detect architecture from `docker-compose.yml`; do not assume single-container apps.
- Be idempotent: describe/check first, create/update only when needed.
- Validate preconditions before mutating resources.
- Ask for missing inputs once, then proceed.
- Use `gcloud` for cloud provisioning, build, deploy, and cleanup.
- Use safe defaults: `--min-instances=0`, no public access for worker.

## Commands Implemented

- `deploy-all`
- `deploy-api`
- `deploy-worker`
- `setup-database`
- `delete-all`
- `full-cleanup`

## Inputs To Collect (Ask If Missing)

Required:

- `PROJECT_ID`
- `REGION` (example: `us-central1`)
- `AR_REPO` (Artifact Registry repo name)
- `API_SERVICE_NAME`
- `WORKER_SERVICE_NAME`
- `SQL_INSTANCE_NAME`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD` (or confirm Secret Manager secret name)

Optional with defaults:

- `PLATFORM` default `managed`
- `API_CPU` default `1`
- `API_MEMORY` default `512Mi`
- `WORKER_CPU` default `1`
- `WORKER_MEMORY` default `512Mi`
- `WORKER_CONCURRENCY` default `1`
- `JOB_MAX_RETRIES` default `5`
- `MAX_INSTANCES_API` default `10`
- `MAX_INSTANCES_WORKER` default `3`

## Step 1 - Detect Local Architecture

1. Confirm `docker-compose.yml` exists.
2. Parse services and verify `api`, `worker`, `postgres` (or equivalents).
3. Capture each service build context and command:
   - API usually default command (`node dist/server.js`).
   - Worker often overrides command (`node dist/worker.js`).
4. If only one build context exists (common case), still produce two images by tag and command override.

If compose does not contain these services, stop with a clear mismatch error and show what was found.

## Step 2 - Preflight Validation

Run and validate:

```bash
gcloud --version
gcloud auth list --filter=status:ACTIVE --format="value(account)"
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com
```

If no active account exists, instruct user to run:

```bash
gcloud auth login
```

## Step 3 - Artifact Registry (Idempotent)

```bash
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" \
  || gcloud artifacts repositories create "$AR_REPO" \
     --repository-format=docker \
     --location="$REGION" \
     --description="Eventflow service images"
```

Image base:

```bash
AR_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO"
API_IMAGE="$AR_BASE/$API_SERVICE_NAME"
WORKER_IMAGE="$AR_BASE/$WORKER_SERVICE_NAME"
```

## Step 4 - Build and Push Images (gcloud only)

Prefer Cloud Build (no local Docker dependency):

```bash
TAG="$(date +%Y%m%d-%H%M%S)"
gcloud builds submit --tag "$API_IMAGE:$TAG" .
gcloud builds submit --tag "$WORKER_IMAGE:$TAG" .
```

Notes:

- If worker needs a different Dockerfile, pass `--config` or `--file` equivalent via Cloud Build config.
- For same Dockerfile, use different runtime command at deploy time.

## Step 5 - Setup Database (`setup-database`)

Create Cloud SQL instance if missing:

```bash
gcloud sql instances describe "$SQL_INSTANCE_NAME" \
  || gcloud sql instances create "$SQL_INSTANCE_NAME" \
     --database-version=POSTGRES_16 \
     --cpu=1 \
     --memory=3840MiB \
     --region="$REGION" \
     --availability-type=zonal \
     --storage-type=SSD \
     --storage-size=20GB
```

Create database and user idempotently:

```bash
gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE_NAME" \
  || gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE_NAME"

USER_EXISTS="$(gcloud sql users list --instance="$SQL_INSTANCE_NAME" --filter="name:$DB_USER" --format='value(name)' | head -n 1)"
if [ -z "$USER_EXISTS" ]; then
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE_NAME" --password="$DB_PASSWORD"
fi
```

Always reset password when provided (safe update path):

```bash
gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE_NAME" --password="$DB_PASSWORD"
```

Get connection name:

```bash
INSTANCE_CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE_NAME" --format='value(connectionName)')"
```

Connection string for Cloud Run + Cloud SQL Unix socket:

```bash
DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@/$DB_NAME?host=/cloudsql/$INSTANCE_CONNECTION_NAME"
```

Cost warning to always show:

- Cloud SQL incurs baseline hourly cost even when API/worker scale to zero.
- Cheapest path for low traffic: smaller instance tier, stop non-prod instances, or managed external PostgreSQL alternatives.

## Step 6 - Deploy API (`deploy-api`)

```bash
gcloud run deploy "$API_SERVICE_NAME" \
  --image "$API_IMAGE:$TAG" \
  --platform "$PLATFORM" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances="$MAX_INSTANCES_API" \
  --cpu="$API_CPU" \
  --memory="$API_MEMORY" \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --set-env-vars "NODE_ENV=production,PORT=3000,DATABASE_URL=$DATABASE_URL"
```

After deploy, print URL:

```bash
gcloud run services describe "$API_SERVICE_NAME" --region "$REGION" --format='value(status.url)'
```

## Step 7 - Deploy Worker (`deploy-worker`)

Worker must be private:

```bash
gcloud run deploy "$WORKER_SERVICE_NAME" \
  --image "$WORKER_IMAGE:$TAG" \
  --platform "$PLATFORM" \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --min-instances=0 \
  --max-instances="$MAX_INSTANCES_WORKER" \
  --concurrency="$WORKER_CONCURRENCY" \
  --cpu="$WORKER_CPU" \
  --memory="$WORKER_MEMORY" \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --command "node" \
  --args "dist/worker.js" \
  --set-env-vars "NODE_ENV=production,DATABASE_URL=$DATABASE_URL,WORKER_CONCURRENCY=$WORKER_CONCURRENCY,JOB_MAX_RETRIES=$JOB_MAX_RETRIES"
```

Important behavior check:

- If worker process does not expose an HTTP listener, Cloud Run service may fail readiness.
- In that case, clearly recommend Cloud Run Jobs for worker execution, or adapt worker to expose health endpoint while processing.

## Step 8 - pg-boss / Queue Compatibility Validation

Validate after deployment:

- API can enqueue jobs to PostgreSQL queue tables.
- Worker can connect to Cloud SQL and consume jobs.
- No firewall or connector errors in logs.

Use logs:

```bash
gcloud run services logs read "$API_SERVICE_NAME" --region "$REGION" --limit=100
gcloud run services logs read "$WORKER_SERVICE_NAME" --region "$REGION" --limit=100
```

Look for:

- successful DB connection
- `pg-boss` startup success
- job processing events without repeated connection failures

## Step 9 - Smart Redeploy (`deploy-all` behavior)

When user runs `deploy-all`:

1. Run preflight and architecture detection.
2. Detect changed files since last deploy and map impact:
   - API-impact paths: `src/server.ts`, `src/routes/**`, shared modules.
   - Worker-impact paths: `src/worker.ts`, `src/actions/**`, queue services.
   - Shared-impact paths: `package.json`, `Dockerfile`, `src/services/**`, `src/db/**` -> redeploy both.
3. Rebuild/redeploy only impacted services.
4. If impact cannot be determined confidently, rebuild both and explain why.

## Command Workflows

### `setup-database`

- Run preflight.
- Provision/validate Cloud SQL, DB, user.
- Return connection name and masked connection string details.

### `deploy-api`

- Ensure preflight + database details exist.
- Build/push API image.
- Deploy API Cloud Run service public.

### `deploy-worker`

- Ensure preflight + database details exist.
- Build/push worker image.
- Deploy private worker Cloud Run service.

### `deploy-all`

- Run architecture detection.
- Run `setup-database` (or validate existing).
- Build and deploy impacted services only.
- Output endpoints and quick verification commands.

### `delete-all`

- Delete API and Worker Cloud Run services.
- Keep Cloud SQL and Artifact Registry by default.

```bash
gcloud run services delete "$API_SERVICE_NAME" --region "$REGION" --quiet || true
gcloud run services delete "$WORKER_SERVICE_NAME" --region "$REGION" --quiet || true
```

### `full-cleanup`

- Delete API + Worker services.
- Ask explicit confirmation before deleting Cloud SQL instance.
- Delete Artifact Registry images (or entire repo if requested).

Cloud SQL destructive step (must confirm):

```bash
gcloud sql instances delete "$SQL_INSTANCE_NAME"
```

Delete all images in repo path:

```bash
gcloud artifacts docker images list "$AR_BASE" --include-tags
gcloud artifacts repositories delete "$AR_REPO" --location="$REGION" --quiet
```

## Error Handling Rules

- Fail fast on missing critical inputs.
- For each gcloud action, verify success before next step.
- If create fails because resource exists, switch to update/describe path.
- Surface actionable remediation, not raw error only.
- Never continue after failed preflight.

## Security and Production Defaults

- API public only when explicitly intended (`--allow-unauthenticated`).
- Worker private by default (`--no-allow-unauthenticated`).
- Use Cloud SQL connector (`--add-cloudsql-instances`) instead of public DB IP.
- Avoid embedding secrets in logs/output.
- Keep min instances at zero unless user requests warm capacity.

## Response Style When Using This Skill

- Show numbered steps.
- Provide executable commands only (copy/paste-ready).
- Keep explanations minimal and precise.
- Call out cost-impacting decisions explicitly.
