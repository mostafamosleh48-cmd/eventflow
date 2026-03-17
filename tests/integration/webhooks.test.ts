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
import { enqueueJob } from '../../src/services/queue';
import type { Job, WebhookResponse } from '../../src/types/pipeline';

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
}

async function truncateTables(): Promise<void> {
  await pool.query('TRUNCATE jobs, subscribers, pipelines CASCADE');
}

describe('POST /webhooks/:sourceToken', () => {
  beforeAll(async () => {
    await ensureTablesExist();
  });

  beforeEach(async () => {
    await truncateTables();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  // Helper: create a pipeline directly via DB and return it
  async function createTestPipeline(overrides: Record<string, unknown> = {}): Promise<{
    id: string;
    source_token: string;
    is_active: boolean;
  }> {
    const defaults = {
      name: 'Test Pipeline',
      source_token: 'test-token-' + Math.random().toString(36).substring(7),
      action_type: 'transform_json',
      action_config: '{}',
      is_active: true,
    };
    const merged = { ...defaults, ...overrides };
    const result = await pool.query(
      `INSERT INTO pipelines (name, source_token, action_type, action_config, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, source_token, is_active`,
      [merged.name, merged.source_token, merged.action_type, merged.action_config, merged.is_active]
    );
    return result.rows[0] as { id: string; source_token: string; is_active: boolean };
  }

  it('should return 202 and create a job for a valid webhook', async () => {
    const pipeline = await createTestPipeline();
    const payload = { event: 'user.created', data: { name: 'John' } };

    const res = await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send(payload)
      .expect(202);

    const body = res.body as WebhookResponse;
    expect(body).toHaveProperty('job_id');
    expect(body.status).toBe('queued');
    expect(body.message).toBe('Webhook received and queued for processing');

    // Verify job was created in the database
    const jobResult = await pool.query<Job>('SELECT * FROM jobs WHERE pipeline_id = $1', [
      pipeline.id,
    ]);
    expect(jobResult.rows).toHaveLength(1);
    expect(jobResult.rows[0].status).toBe('pending');
    expect(jobResult.rows[0].payload).toEqual(payload);
  });

  it('should call enqueueJob with correct parameters', async () => {
    const pipeline = await createTestPipeline();
    const payload = { test: 'data' };

    const res = await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send(payload)
      .expect(202);

    const body = res.body as WebhookResponse;
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith(body.job_id, pipeline.id, payload);
  });

  it('should return 404 for non-existent source token', async () => {
    const res = await request(app)
      .post('/webhooks/non-existent-token')
      .send({ event: 'test' })
      .expect(404);

    const body = res.body as { error: { message: string; status: number } };
    expect(body.error).toBeDefined();
    expect(body.error.status).toBe(404);
  });

  it('should return 404 for inactive pipeline', async () => {
    const pipeline = await createTestPipeline({ is_active: false });

    const res = await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send({ event: 'test' })
      .expect(404);

    const body = res.body as { error: { message: string; status: number } };
    expect(body.error).toBeDefined();
    expect(body.error.status).toBe(404);

    // Verify no job was created
    const jobResult = await pool.query('SELECT * FROM jobs WHERE pipeline_id = $1', [pipeline.id]);
    expect(jobResult.rows).toHaveLength(0);
  });

  it('should store the correct payload in the job', async () => {
    const pipeline = await createTestPipeline();
    const complexPayload = {
      event: 'order.completed',
      data: {
        orderId: 12345,
        items: [{ name: 'Widget', qty: 2 }],
        metadata: { source: 'api' },
      },
    };

    await request(app).post(`/webhooks/${pipeline.source_token}`).send(complexPayload).expect(202);

    const jobResult = await pool.query<Pick<Job, 'payload'>>(
      'SELECT payload FROM jobs WHERE pipeline_id = $1',
      [pipeline.id]
    );
    expect(jobResult.rows[0].payload).toEqual(complexPayload);
  });

  it('should create jobs with pending status', async () => {
    const pipeline = await createTestPipeline();

    await request(app).post(`/webhooks/${pipeline.source_token}`).send({ test: true }).expect(202);

    const jobResult = await pool.query<Pick<Job, 'status'>>(
      'SELECT status FROM jobs WHERE pipeline_id = $1',
      [pipeline.id]
    );
    expect(jobResult.rows[0].status).toBe('pending');
  });

  it('should handle multiple webhooks to the same pipeline', async () => {
    const pipeline = await createTestPipeline();

    await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send({ event: 'first' })
      .expect(202);

    await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send({ event: 'second' })
      .expect(202);

    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE pipeline_id = $1 ORDER BY created_at',
      [pipeline.id]
    );
    expect(jobResult.rows).toHaveLength(2);
  });

  it('should return unique job_ids for each webhook', async () => {
    const pipeline = await createTestPipeline();

    const res1 = await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send({ event: 'first' })
      .expect(202);

    const res2 = await request(app)
      .post(`/webhooks/${pipeline.source_token}`)
      .send({ event: 'second' })
      .expect(202);

    const body1 = res1.body as WebhookResponse;
    const body2 = res2.body as WebhookResponse;
    expect(body1.job_id).not.toBe(body2.job_id);
  });
});
