Run a production deploy for the Eventflow API service to Google Cloud Run and return the live URL.

Execution mode:

- Be strict and deterministic.
- Do not claim success unless Cloud Run deploy succeeds and `/health` returns HTTP 200.

Behavior:

1. Auto-resolve inputs, collect only what cannot be inferred:

- PROJECT_ID: use explicit input, else `gcloud config get-value project`
- REGION: use explicit input, else `gcloud config get-value run/region`, else `us-central1`
- AR_REPO: default `eventflow`
- SERVICE_NAME: default `eventflow-api`
- IMAGE_NAME: default same as `SERVICE_NAME`
- PORT: default `3000` (for `--port` only)
- Database config (required for this app):
  - Prefer explicit `DATABASE_URL` input
  - Else build from SQL tuple: `SQL_INSTANCE_CONNECTION_NAME`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
  - SQL tuple defaults when omitted:
    - `SQL_INSTANCE_CONNECTION_NAME`: first Cloud SQL instance connection name in project
    - `DB_NAME`: `eventflow_db`
    - `DB_USER`: `eventflow_app`
    - `DB_PASSWORD`: `eventloop`

Important app requirement:

- This app requires `DATABASE_URL` at startup. Do not deploy as success if DB config is missing.
- If autodetection fails to produce complete DB config, stop early and return `failure` with clear next steps.
- Hard gate: never run `gcloud run deploy` until DB config is fully resolved.

2. Validate preflight:

- gcloud auth list (must have active account)
- gcloud config set project PROJECT_ID
- gcloud config set run/region REGION
- enable APIs: run.googleapis.com, artifactregistry.googleapis.com, cloudbuild.googleapis.com

Preflight DB check:

- If `DATABASE_URL` is provided, use it directly.
- Else compose SQL tuple using explicit values plus defaults/autodetection.
- Validate tuple completeness; if incomplete, return `failure` and stop.

3. Ensure Artifact Registry repo exists (create if missing).
4. Build and push image with unique timestamp tag using `gcloud builds submit`.
5. Deploy Cloud Run service:

- allow unauthenticated
- min instances 0
- set NODE_ENV=production (never set PORT as env var; Cloud Run manages PORT)
- set `--port PORT`
- if DATABASE_URL is provided directly:
  - set env `DATABASE_URL=...`
- if SQL tuple is provided instead:
  - build DATABASE_URL with unix socket `/cloudsql/SQL_INSTANCE_CONNECTION_NAME`
  - add Cloud SQL connection via `--add-cloudsql-instances`
  - set env `DATABASE_URL=...`

Cloud Run safety rule:

- Never include `PORT` in `--set-env-vars` because Cloud Run rejects reserved env names.

6. Fetch and print service URL.
7. Validate runtime health:

- run `curl -sS -o /dev/null -w "%{http_code}" <url>/health` (or platform equivalent)
- if request fails or logs show DB startup error, return `failure` with remediation command.

Output format (exact sections):

- Deployment status (success/failure)
- Project, region, service name
- Image tag deployed
- Service URL
- One verification command (`curl <url>/health` if available)
- If failed, include likely cause and next fix command.
