import { randomUUID } from 'node:crypto';

import request from 'supertest';

// Mock the queue service BEFORE importing app
jest.mock('../../src/services/queue', () => ({
  startQueue: jest.fn().mockResolvedValue({}),
  stopQueue: jest.fn().mockResolvedValue(undefined),
  enqueueJob: jest.fn().mockResolvedValue('mock-pg-boss-id'),
  getQueueName: jest.fn().mockReturnValue('webhook-jobs'),
  getQueueInstance: jest.fn().mockReturnValue(null),
}));

import app from '../../src/server';
import pool from '../../src/db/pool';

const BASE = '/api/v1/jobs';

interface InsertedPipeline {
  id: string;
}

interface InsertedSubscriber {
  id: string;
  pipeline_id: string;
}

interface InsertedJob {
  id: string;
  pipeline_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

interface JobResponse {
  id: string;
  pipeline_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface JobListResponse {
  data: JobResponse[];
  total: number;
  limit: number;
  offset: number;
}

interface DeliveryAttemptResponse {
  attempt_number: number;
  subscriber_url: string;
  status_code: number | null;
  success: boolean;
}

interface JobDeliveriesResponse {
  job_id: string;
  deliveries: DeliveryAttemptResponse[];
}

async function ensureTablesExist(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT NOT NULL,
      description   TEXT,
      source_token  TEXT UNIQUE NOT NULL,
      action_type   TEXT NOT NULL,
      action_config JSONB NOT NULL DEFAULT '{}',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      url         TEXT NOT NULL,
      headers     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pipeline_id   UUID NOT NULL REFERENCES pipelines(id),
      status        TEXT NOT NULL DEFAULT 'pending',
      payload       JSONB NOT NULL,
      result        JSONB,
      error_message TEXT,
      attempts      INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id         UUID NOT NULL REFERENCES jobs(id),
      subscriber_id  UUID NOT NULL REFERENCES subscribers(id),
      status_code    INT,
      success        BOOLEAN NOT NULL,
      response_body  TEXT,
      attempt_number INT NOT NULL DEFAULT 1,
      attempted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function truncateTables(): Promise<void> {
  await pool.query('TRUNCATE delivery_attempts, jobs, subscribers, pipelines CASCADE');
}

async function createPipeline(name: string): Promise<InsertedPipeline> {
  const result = await pool.query<InsertedPipeline>(
    `INSERT INTO pipelines (name, source_token, action_type, action_config, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [name, `token-${randomUUID()}`, 'transform_json', JSON.stringify({}), true]
  );

  return result.rows[0];
}

async function createSubscriber(pipelineId: string, url: string): Promise<InsertedSubscriber> {
  const result = await pool.query<InsertedSubscriber>(
    `INSERT INTO subscribers (pipeline_id, url, headers)
     VALUES ($1, $2, $3)
     RETURNING id, pipeline_id`,
    [pipelineId, url, JSON.stringify({})]
  );

  return result.rows[0];
}

async function createJob(
  pipelineId: string,
  status: InsertedJob['status'],
  payload: Record<string, unknown>,
  resultPayload: Record<string, unknown> | null
): Promise<InsertedJob> {
  const result = await pool.query<InsertedJob>(
    `INSERT INTO jobs (pipeline_id, status, payload, result)
     VALUES ($1, $2, $3, $4)
     RETURNING id, pipeline_id, status, payload, result`,
    [
      pipelineId,
      status,
      JSON.stringify(payload),
      resultPayload ? JSON.stringify(resultPayload) : null,
    ]
  );

  return result.rows[0];
}

describe('Jobs observability endpoints', () => {
  beforeAll(async () => {
    await ensureTablesExist();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('GET /api/v1/jobs/:id', () => {
    it('returns a single job with status, payload, result, and timestamps', async () => {
      const pipeline = await createPipeline('job-status-pipeline');
      const createdJob = await createJob(
        pipeline.id,
        'completed',
        { event: 'user.created' },
        { transformed: true }
      );

      const res = await request(app).get(`${BASE}/${createdJob.id}`).expect(200);
      const body = res.body as JobResponse;

      expect(body.id).toBe(createdJob.id);
      expect(body.pipeline_id).toBe(pipeline.id);
      expect(body.status).toBe('completed');
      expect(body.payload).toEqual({ event: 'user.created' });
      expect(body.result).toEqual({ transformed: true });
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
      expect(body).toHaveProperty('completed_at');
    });

    it('returns 404 for unknown job id', async () => {
      await request(app).get(`${BASE}/${randomUUID()}`).expect(404);
    });
  });

  describe('GET /api/v1/jobs', () => {
    it('lists jobs and applies pipeline_id + status filters with pagination', async () => {
      const pipelineA = await createPipeline('pipeline-a');
      const pipelineB = await createPipeline('pipeline-b');

      await createJob(pipelineA.id, 'completed', { event: 'a1' }, { ok: true });
      await createJob(pipelineA.id, 'failed', { event: 'a2' }, null);
      await createJob(pipelineA.id, 'completed', { event: 'a3' }, { ok: true });
      await createJob(pipelineB.id, 'completed', { event: 'b1' }, { ok: true });

      const filteredRes = await request(app)
        .get(`${BASE}?pipeline_id=${pipelineA.id}&status=completed&limit=1&offset=0`)
        .expect(200);
      const filteredBody = filteredRes.body as JobListResponse;

      expect(filteredBody.total).toBe(2);
      expect(filteredBody.limit).toBe(1);
      expect(filteredBody.offset).toBe(0);
      expect(filteredBody.data).toHaveLength(1);
      expect(filteredBody.data[0].pipeline_id).toBe(pipelineA.id);
      expect(filteredBody.data[0].status).toBe('completed');

      const secondPageRes = await request(app)
        .get(`${BASE}?pipeline_id=${pipelineA.id}&status=completed&limit=1&offset=1`)
        .expect(200);
      const secondPageBody = secondPageRes.body as JobListResponse;

      expect(secondPageBody.total).toBe(2);
      expect(secondPageBody.data).toHaveLength(1);
      expect(secondPageBody.data[0].pipeline_id).toBe(pipelineA.id);
      expect(secondPageBody.data[0].status).toBe('completed');
    });
  });

  describe('GET /api/v1/jobs/:id/deliveries', () => {
    it('returns delivery attempt history including subscriber URL', async () => {
      const pipeline = await createPipeline('delivery-history-pipeline');
      const subscriber = await createSubscriber(pipeline.id, 'https://subscriber.example/webhook');
      const job = await createJob(pipeline.id, 'completed', { event: 'ready' }, { ok: true });

      await pool.query(
        `INSERT INTO delivery_attempts (job_id, subscriber_id, status_code, success, response_body, attempt_number)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [job.id, subscriber.id, 500, false, 'server error', 1]
      );

      await pool.query(
        `INSERT INTO delivery_attempts (job_id, subscriber_id, status_code, success, response_body, attempt_number)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [job.id, subscriber.id, 200, true, 'ok', 2]
      );

      const res = await request(app).get(`${BASE}/${job.id}/deliveries`).expect(200);
      const body = res.body as JobDeliveriesResponse;

      expect(body.job_id).toBe(job.id);
      expect(body.deliveries).toHaveLength(2);

      expect(body.deliveries[0].attempt_number).toBe(1);
      expect(body.deliveries[0].subscriber_url).toBe('https://subscriber.example/webhook');
      expect(body.deliveries[0].status_code).toBe(500);
      expect(body.deliveries[0].success).toBe(false);

      expect(body.deliveries[1].attempt_number).toBe(2);
      expect(body.deliveries[1].status_code).toBe(200);
      expect(body.deliveries[1].success).toBe(true);
    });

    it('returns 404 when requesting deliveries for a missing job', async () => {
      await request(app).get(`${BASE}/${randomUUID()}/deliveries`).expect(404);
    });
  });
});
