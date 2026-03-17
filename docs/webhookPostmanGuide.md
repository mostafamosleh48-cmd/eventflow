# Webhook API Zero-to-Hero (Postman)

This guide walks you from local setup to sending your first webhook, using Postman end-to-end.

## 1) Prerequisites

- Docker Desktop (recommended) or a local Node + Postgres setup.
- Postman installed.

## 2) Start the stack

### Option A: Docker (recommended)

```bash
docker compose up --build
```

In another terminal, run migrations:

```bash
docker compose exec api npm run migrate
```

### Option B: Local Node + Postgres

1. Set env vars (example):

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://user:pass@localhost:5432/pipeline_db
WORKER_CONCURRENCY=3
JOB_MAX_RETRIES=5
```

2. Install and start:

```bash
npm install
npm run dev
```

3. Run migrations:

```bash
npm run migrate
```

## 3) Postman setup

### Create an environment

Add a Postman environment named `eventflow-local` with these variables:

- `base_url`: `http://localhost:3000`
- `api_base`: `http://localhost:3000/api/v1`

### Helpful collection headers (optional)

Set a collection-level header:

- `Content-Type: application/json`

## 4) Create a pipeline

### Request

- Method: `POST`
- URL: `{{api_base}}/pipelines`
- Body (raw JSON):

```json
{
  "name": "Postman Demo Pipeline",
  "description": "Pipeline created from Postman",
  "action_type": "enrich_timestamp",
  "action_config": {},
  "subscribers": [
    {
      "url": "https://webhook.site/your-test-url",
      "headers": { "X-Demo": "postman" }
    }
  ]
}
```

### Expected response (201)

```json
{
  "id": "<uuid>",
  "source_url": "http://localhost:3000/webhooks/<source_token>",
  "name": "Postman Demo Pipeline",
  "action_type": "enrich_timestamp",
  "subscribers": [
    {
      "id": "<uuid>",
      "pipeline_id": "<uuid>",
      "url": "https://webhook.site/your-test-url",
      "headers": { "X-Demo": "postman" },
      "created_at": "<timestamp>"
    }
  ]
}
```

Copy the `source_url` value. This is your webhook ingestion URL.

## 5) Send a webhook

### Request

- Method: `POST`
- URL: `{{source_url}}` (or paste the `source_url` value)
- Body (raw JSON):

```json
{
  "event": "order.created",
  "order": {
    "id": 123,
    "total": 49.95,
    "customer": "Ava"
  }
}
```

### Expected response (202)

```json
{
  "job_id": "<uuid>",
  "status": "queued",
  "message": "Webhook received and queued for processing"
}
```

## 6) Common expected errors

### Pipeline not found or inactive

- Status: `404`
- When: invalid `source_token` or pipeline `is_active = false`.

### Invalid JSON body

- Status: `400`
- When: body is not a JSON object (array, string, or empty).

## 7) Troubleshooting

- **Migrations fail:** confirm Postgres is reachable and `DATABASE_URL` is correct, then re-run `npm run migrate`.
- **Webhook returns 404:** make sure you are using the `source_url` from the pipeline create response.
- **Job stays pending:** ensure the worker is running (`docker compose logs -f worker`).
- **Subscriber not receiving payload:** verify the subscriber URL is reachable and returns `2xx`.
- **Postman shows no response body:** ensure `Content-Type: application/json` and valid JSON in the body.

## 8) Quick reference endpoints

- `POST {{api_base}}/pipelines` create pipeline
- `GET {{api_base}}/pipelines` list pipelines
- `GET {{api_base}}/pipelines/:id` get pipeline
- `PATCH {{api_base}}/pipelines/:id` update pipeline
- `DELETE {{api_base}}/pipelines/:id` delete pipeline
- `POST {{base_url}}/webhooks/:sourceToken` ingest webhook
- `GET {{base_url}}/health` health check
