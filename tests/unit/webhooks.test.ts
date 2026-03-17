import request from 'supertest';

import type { Job, Pipeline } from '../../src/types/pipeline';

// Mock the queue module BEFORE importing app
jest.mock('../../src/services/queue', () => ({
  startQueue: jest.fn().mockResolvedValue({}),
  stopQueue: jest.fn().mockResolvedValue(undefined),
  enqueueJob: jest.fn().mockResolvedValue('mock-pg-boss-id'),
  getQueueName: jest.fn().mockReturnValue('webhook-jobs'),
  getQueueInstance: jest.fn().mockReturnValue(null),
}));

jest.mock('../../src/db/pool', () => {
  const mockPool = {
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  };
  return { __esModule: true, default: mockPool };
});

/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import app from '../../src/server';
import pool from '../../src/db/pool';
import { enqueueJob } from '../../src/services/queue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method
const mockQuery: jest.Mock<any> = pool.query as jest.Mock<any>;
const mockEnqueueJob = enqueueJob as jest.MockedFunction<typeof enqueueJob>;

// Reusable fixtures
const MOCK_SOURCE_TOKEN = 'test-source-token-abc';

const MOCK_PIPELINE: Pipeline = {
  id: 'pipeline-uuid-123',
  name: 'Test Pipeline',
  description: 'A pipeline for testing',
  source_token: MOCK_SOURCE_TOKEN,
  action_type: 'transform_json',
  action_config: { mapping: { out: 'in' } },
  is_active: true,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

const MOCK_JOB: Job = {
  id: 'job-uuid-456',
  pipeline_id: 'pipeline-uuid-123',
  status: 'pending',
  payload: { event: 'test' },
  result: null,
  error_message: null,
  attempts: 0,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
  completed_at: null,
};

describe('POST /webhooks/:sourceToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 404 when pipeline not found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const res = await request(app)
      .post(`/webhooks/${MOCK_SOURCE_TOKEN}`)
      .send({ event: 'test' })
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.status).toBe(404);
    expect(res.body.error.message).toMatch(/not found/i);
  });

  it('returns 404 when pipeline is inactive', async () => {
    const inactivePipeline: Pipeline = { ...MOCK_PIPELINE, is_active: false };

    mockQuery.mockResolvedValueOnce({
      rows: [inactivePipeline],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const res = await request(app)
      .post(`/webhooks/${MOCK_SOURCE_TOKEN}`)
      .send({ event: 'test' })
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.status).toBe(404);
    expect(res.body.error.message).toMatch(/not found/i);
  });

  it('returns 202 with job_id when webhook is valid', async () => {
    // First query: pipeline lookup
    mockQuery.mockResolvedValueOnce({
      rows: [MOCK_PIPELINE],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    // Second query: job insertion
    mockQuery.mockResolvedValueOnce({
      rows: [MOCK_JOB],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    const res = await request(app)
      .post(`/webhooks/${MOCK_SOURCE_TOKEN}`)
      .send({ event: 'test' })
      .expect(202);

    expect(res.body.job_id).toBe(MOCK_JOB.id);
    expect(res.body.status).toBe('queued');
  });

  it('returns correct response structure', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [MOCK_PIPELINE],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    mockQuery.mockResolvedValueOnce({
      rows: [MOCK_JOB],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    const res = await request(app)
      .post(`/webhooks/${MOCK_SOURCE_TOKEN}`)
      .send({ event: 'test' })
      .expect(202);

    expect(res.body).toEqual({
      job_id: MOCK_JOB.id,
      status: 'queued',
      message: 'Webhook received and queued for processing',
    });
  });

  it('calls enqueueJob with correct parameters', async () => {
    const payload = { event: 'user.created', user_id: 42 };

    mockQuery.mockResolvedValueOnce({
      rows: [MOCK_PIPELINE],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    mockQuery.mockResolvedValueOnce({
      rows: [MOCK_JOB],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    await request(app).post(`/webhooks/${MOCK_SOURCE_TOKEN}`).send(payload).expect(202);

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(MOCK_JOB.id, MOCK_PIPELINE.id, payload);
  });
});
