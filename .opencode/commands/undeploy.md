Undeploy the Eventflow API Cloud Run service safely.

Behavior:

1. Auto-resolve inputs, collect only what cannot be inferred:

- PROJECT_ID: use explicit input, else `gcloud config get-value project`
- REGION: use explicit input, else `gcloud config get-value run/region`, else `us-central1`
- SERVICE_NAME: default `eventflow-api`
- AR_REPO: default `eventflow` (required only if image cleanup is requested)
- IMAGE_NAME: default same as `SERVICE_NAME` (used for image cleanup)
- Optional boolean: DELETE_IMAGES (default: false)
- Optional boolean: DELETE_AR_REPO (default: false, destructive)

2. Preflight:

- active gcloud auth
- set project and region

3. Delete Cloud Run service (idempotent; if missing, report already deleted).
4. Verify deletion by checking service describe/list.
5. If DELETE_IMAGES=true:

- list images under `REGION-docker.pkg.dev/PROJECT_ID/AR_REPO/IMAGE_NAME`
- ask for explicit confirmation before deleting image tags/digests
- remove images only after confirmation

6. If DELETE_AR_REPO=true:

- require explicit confirmation phrase before deleting repo
- then delete Artifact Registry repo

Safety rules:

- Never delete Cloud SQL here.
- Never perform destructive cleanup unless explicitly requested.
- If resource does not exist, return success as no-op.

Output format (exact sections):

- Undeploy status
- Service deletion result
- Optional cleanup result (images/repo)
- Remaining resources summary
- Suggested next command (`/deploy`).
