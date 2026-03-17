/* eslint-disable @typescript-eslint/no-explicit-any */

const mockEnqueueDeliveryRetry = jest.fn().mockResolvedValue('retry-job-id');

jest.mock('../../src/services/queue', () => ({
  enqueueDeliveryRetry: mockEnqueueDeliveryRetry,
  startQueue: jest.fn(),
  stopQueue: jest.fn(),
  getQueueName: jest.fn(),
}));

import pool from '../../src/db/pool';
import { processQueueJob } from '../../src/worker';
import type { Job, Pipeline, Subscriber } from '../../src/types/pipeline';

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

describe('delivery retry integration', () => {
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

  it('records failed delivery attempt and schedules retry', async () => {
    const pipelineResult = await pool.query<Pipeline>(
      `INSERT INTO pipelines (name, source_token, action_type, action_config, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        'Retry Pipeline',
        `retry-token-${Date.now()}`,
        'transform_json',
        JSON.stringify({ mapping: { user_id: 'id' } }),
        true,
      ]
    );
    const pipeline = pipelineResult.rows[0];

    const subscriberResult = await pool.query<Subscriber>(
      `INSERT INTO subscribers (pipeline_id, url, headers)
       VALUES ($1, $2, $3)
       RETURNING id, pipeline_id, url, headers, created_at`,
      [pipeline.id, 'http://127.0.0.1:9/unreachable', JSON.stringify({})]
    );
    const subscriber = subscriberResult.rows[0];

    const jobResult = await pool.query<Job>(
      `INSERT INTO jobs (pipeline_id, status, payload)
       VALUES ($1, 'pending', $2)
       RETURNING *`,
      [pipeline.id, JSON.stringify({ id: 42, ignored: true })]
    );
    const job = jobResult.rows[0];

    await processQueueJob({
      jobId: job.id,
      pipelineId: pipeline.id,
      payload: { id: 42, ignored: true },
    });

    const attempts = await pool.query<{
      success: boolean;
      status_code: number | null;
      attempt_number: number;
    }>(
      `SELECT success, status_code, attempt_number
       FROM delivery_attempts
       WHERE job_id = $1 AND subscriber_id = $2`,
      [job.id, subscriber.id]
    );

    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].success).toBe(false);
    expect(attempts.rows[0].status_code).toBeNull();
    expect(attempts.rows[0].attempt_number).toBe(1);

    expect(mockEnqueueDeliveryRetry).toHaveBeenCalledWith(
      job.id,
      pipeline.id,
      subscriber.id,
      { user_id: 42 },
      2,
      30
    );
  });
});
