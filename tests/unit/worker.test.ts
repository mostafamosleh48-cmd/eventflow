/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */

import type { Pipeline, Subscriber } from '../../src/types/pipeline';

let capturedWorkHandler: (jobs: any[]) => Promise<void>;
let capturedWorkOptions: Record<string, unknown> = {};

const mockBoss = {
  work: jest.fn().mockImplementation((_queue: string, opts: any, handler: any) => {
    capturedWorkOptions = opts as Record<string, unknown>;
    capturedWorkHandler = handler as (jobs: any[]) => Promise<void>;
    return Promise.resolve();
  }),
  on: jest.fn(),
};

jest.mock('../../src/services/queue', () => ({
  startQueue: jest.fn().mockResolvedValue(mockBoss),
  stopQueue: jest.fn().mockResolvedValue(undefined),
  getQueueName: jest.fn().mockReturnValue('webhook-jobs'),
  getQueueInstance: jest.fn().mockReturnValue(mockBoss),
  enqueueDeliveryRetry: jest.fn().mockResolvedValue('retry-job-id'),
}));

jest.mock('../../src/db/pool', () => {
  const mockPool = {
    query: jest.fn(),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: mockPool };
});

jest.mock('../../src/actions/index', () => ({
  runAction: jest.fn(),
}));

jest.mock('../../src/services/delivery', () => ({
  deliverToSubscriber: jest.fn(),
  calculateDeliveryRetryDelaySeconds: jest.fn(),
  MAX_DELIVERY_ATTEMPTS: 5,
}));

const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

import { runAction } from '../../src/actions/index';
import pool from '../../src/db/pool';
import {
  calculateDeliveryRetryDelaySeconds,
  deliverToSubscriber,
} from '../../src/services/delivery';
import { enqueueDeliveryRetry, getQueueName, startQueue } from '../../src/services/queue';
import { startWorker } from '../../src/worker';

const mockQuery = pool.query as jest.Mock<any>;
const mockRunAction = runAction as jest.Mock<any>;
const mockDeliverToSubscriber = deliverToSubscriber as jest.Mock<any>;
const mockCalculateRetryDelay = calculateDeliveryRetryDelaySeconds as jest.Mock<any>;
const mockEnqueueDeliveryRetry = enqueueDeliveryRetry as jest.Mock<any>;

const MOCK_PIPELINE: Pipeline = {
  id: 'pipeline-uuid-123',
  name: 'Test Pipeline',
  description: 'A pipeline for testing',
  source_token: 'test-source-token-abc',
  action_type: 'transform_json',
  action_config: { mapping: { out: 'in' } },
  is_active: true,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

const MOCK_SUBSCRIBER: Subscriber = {
  id: 'subscriber-uuid-1',
  pipeline_id: 'pipeline-uuid-123',
  url: 'https://example.com/webhook',
  headers: { Authorization: 'Bearer test' },
  created_at: '2025-01-01T00:00:00.000Z',
};

function makePgBossJob(data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'pgboss-job-id',
    name: 'webhook-jobs',
    data,
  };
}

function mockQueryResult(
  rows: unknown[] = [],
  command = 'UPDATE'
): {
  rows: unknown[];
  rowCount: number;
  command: string;
  oid: number;
  fields: unknown[];
} {
  return { rows, rowCount: rows.length, command, oid: 0, fields: [] };
}

let startupStartQueueCallCount: number;
let startupBossWorkCallCount: number;
let startupGetQueueNameCallCount: number;
let startupBossWorkArgs: unknown[];

describe('Worker', () => {
  beforeAll(async () => {
    await startWorker();

    startupStartQueueCallCount = (startQueue as jest.Mock).mock.calls.length;
    startupBossWorkCallCount = mockBoss.work.mock.calls.length;
    startupGetQueueNameCallCount = (getQueueName as jest.Mock).mock.calls.length;
    startupBossWorkArgs = mockBoss.work.mock.calls[0] ?? [];
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('startup', () => {
    it('calls startQueue on import', () => {
      expect(startupStartQueueCallCount).toBe(1);
    });

    it('subscribes to the webhook-jobs queue', () => {
      expect(startupBossWorkCallCount).toBe(1);
      expect(startupBossWorkArgs[0]).toBe('webhook-jobs');
      expect(typeof startupBossWorkArgs[2]).toBe('function');
    });

    it('uses getQueueName to determine queue name', () => {
      expect(startupGetQueueNameCallCount).toBeGreaterThanOrEqual(1);
    });

    it('defaults concurrency to 3 when WORKER_CONCURRENCY is not set', () => {
      expect(capturedWorkOptions).toMatchObject({
        localConcurrency: 3,
      });
    });
  });

  describe('processWebhookJob — success', () => {
    const jobData = {
      jobId: 'job-uuid-456',
      pipelineId: 'pipeline-uuid-123',
      payload: { event: 'user.created', user_id: 42 },
    };

    const transformedResult = { out: 'in', event: 'user.created' };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult());
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_PIPELINE], 'SELECT'));
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_SUBSCRIBER], 'SELECT'));
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      mockRunAction.mockReturnValue(transformedResult);
      mockDeliverToSubscriber.mockResolvedValue({
        success: true,
        statusCode: 200,
        responseBody: 'ok',
        attemptNumber: 1,
      });

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('updates job status to processing first', () => {
      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(firstCall[1]).toContain('processing');
      expect(firstCall[1]).toContain('job-uuid-456');
    });

    it('calls runAction and delivery', () => {
      expect(mockRunAction).toHaveBeenCalledTimes(1);
      expect(mockDeliverToSubscriber).toHaveBeenCalledWith(
        'job-uuid-456',
        MOCK_SUBSCRIBER,
        transformedResult,
        1
      );
    });

    it('marks the job as completed', () => {
      const finalCall = mockQuery.mock.calls[3];
      expect(finalCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(finalCall[1]).toContain('completed');
      expect(finalCall[1]).toContain('job-uuid-456');
    });

    it('does not enqueue retry on successful delivery', () => {
      expect(mockEnqueueDeliveryRetry).not.toHaveBeenCalled();
    });
  });

  describe('processWebhookJob — failed first delivery', () => {
    const jobData = {
      jobId: 'job-uuid-fail-delivery',
      pipelineId: 'pipeline-uuid-123',
      payload: { event: 'user.created' },
    };

    const transformedResult = { transformed: true };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult());
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_PIPELINE], 'SELECT'));
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_SUBSCRIBER], 'SELECT'));
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      mockRunAction.mockReturnValue(transformedResult);
      mockDeliverToSubscriber.mockResolvedValue({
        success: false,
        statusCode: 500,
        responseBody: 'error',
        attemptNumber: 1,
      });
      mockCalculateRetryDelay.mockReturnValue(30);

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('schedules delayed retry after failed delivery', () => {
      expect(mockCalculateRetryDelay).toHaveBeenCalledWith(1);
      expect(mockEnqueueDeliveryRetry).toHaveBeenCalledWith(
        'job-uuid-fail-delivery',
        'pipeline-uuid-123',
        'subscriber-uuid-1',
        transformedResult,
        2,
        30
      );
    });
  });

  describe('processDeliveryRetryJob — success', () => {
    const retryJobData = {
      type: 'delivery_retry' as const,
      jobId: 'job-uuid-456',
      pipelineId: 'pipeline-uuid-123',
      subscriberId: 'subscriber-uuid-1',
      payload: { transformed: true },
      attemptNumber: 2,
    };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_SUBSCRIBER], 'SELECT'));
      mockDeliverToSubscriber.mockResolvedValue({
        success: true,
        statusCode: 204,
        responseBody: '',
        attemptNumber: 2,
      });

      await capturedWorkHandler([makePgBossJob(retryJobData)]);
    });

    it('delivers retry payload with current attempt number', () => {
      expect(mockDeliverToSubscriber).toHaveBeenCalledWith(
        'job-uuid-456',
        MOCK_SUBSCRIBER,
        retryJobData.payload,
        2
      );
      expect(mockEnqueueDeliveryRetry).not.toHaveBeenCalled();
    });
  });

  describe('processDeliveryRetryJob — failure on max attempt', () => {
    const retryJobData = {
      type: 'delivery_retry' as const,
      jobId: 'job-uuid-456',
      pipelineId: 'pipeline-uuid-123',
      subscriberId: 'subscriber-uuid-1',
      payload: { transformed: true },
      attemptNumber: 5,
    };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_SUBSCRIBER], 'SELECT'));
      mockDeliverToSubscriber.mockResolvedValue({
        success: false,
        statusCode: 500,
        responseBody: 'still failing',
        attemptNumber: 5,
      });

      await capturedWorkHandler([makePgBossJob(retryJobData)]);
    });

    it('does not enqueue more retries after attempt 5', () => {
      expect(mockEnqueueDeliveryRetry).not.toHaveBeenCalled();
      expect(mockCalculateRetryDelay).not.toHaveBeenCalled();
    });
  });

  describe('processWebhookJob — pipeline not found', () => {
    const jobData = {
      jobId: 'job-uuid-789',
      pipelineId: 'missing-pipeline-id',
      payload: { event: 'test' },
    };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult());
      mockQuery.mockResolvedValueOnce(mockQueryResult([], 'SELECT'));
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('marks the job as failed', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(thirdCall[1]).toContain('failed');
    });
  });

  describe('processWebhookJob — action failure', () => {
    const jobData = {
      jobId: 'job-uuid-err',
      pipelineId: 'pipeline-uuid-123',
      payload: { bad: 'data' },
    };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult());
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_PIPELINE], 'SELECT'));

      mockRunAction.mockImplementation(() => {
        throw new Error('Invalid mapping configuration');
      });

      mockQuery.mockResolvedValueOnce(mockQueryResult());

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('marks the job as failed and stores error', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[1]).toContain('failed');
      expect(thirdCall[1]).toContain('Invalid mapping configuration');
    });
  });

  describe('shutdown', () => {
    afterEach(() => {
      mockExit.mockClear();
    });

    it('process.exit mock is in place', () => {
      expect(mockExit).toBeDefined();
    });
  });
});
