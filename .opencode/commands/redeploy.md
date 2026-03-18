Force rebuild and redeploy the Eventflow API service, then return the updated URL and revision.

Execution mode:

- Be strict and deterministic.
- Do not claim success unless Cloud Run redeploy succeeds and `/health` returns HTTP 200.

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

- This app requires `DATABASE_URL` at startup. Do not mark redeploy success if DB config is missing.
- Hard gate: never run `gcloud run deploy` until DB config is fully resolved.

2. Preflight checks:

- active gcloud auth
- project + region configured
- required APIs enabled

Preflight DB check:

- If `DATABASE_URL` is provided, use it directly.
- Else compose SQL tuple using explicit values plus defaults/autodetection.
- Validate tuple completeness; if incomplete, return `failure` and stop.

3. Read current service state first:

- current URL
- latest ready revision

4. Build a fresh image with a new timestamp tag via `gcloud builds submit`.
5. Redeploy Cloud Run service with the new tag (same runtime settings as deploy):

- set NODE_ENV=production
- set `--port PORT`
- never set `PORT` in `--set-env-vars`
- set DATABASE_URL using direct value or SQL tuple logic
- apply `--add-cloudsql-instances` when SQL tuple path is used

6. Read service state again after rollout:

- URL
- latest ready revision
- traffic target

7. Validate runtime health:

- run `curl -sS -o /dev/null -w "%{http_code}" <url>/health` (or platform equivalent)
- if it fails or logs show startup/DB error, return `failure` with remediation command.

Output format (exact sections):

- Redeploy status (success/failure)
- Previous revision -> New revision
- Previous image (if found) -> New image
- Service URL
- Rollout confirmation (traffic on new revision)
- If failed, include remediation commands.
