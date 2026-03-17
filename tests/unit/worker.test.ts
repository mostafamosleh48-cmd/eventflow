/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */

import type { Pipeline } from '../../src/types/pipeline';

// ---------------------------------------------------------------------------
// Mock setup — must come before importing the worker module
// ---------------------------------------------------------------------------

// Capture the handler passed to boss.work() so we can invoke it in tests
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

// Prevent process.exit from actually exiting during tests
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import pool from '../../src/db/pool';
import { startQueue, getQueueName } from '../../src/services/queue';
import { runAction } from '../../src/actions/index';

const mockQuery = pool.query as jest.Mock<any>;
const mockRunAction = runAction as jest.Mock<any>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Track startup state before any beforeEach clears mocks
let startupStartQueueCallCount: number;
let startupBossWorkCallCount: number;
let startupGetQueueNameCallCount: number;
let startupBossWorkArgs: unknown[];

describe('Worker', () => {
  beforeAll(async () => {
    // Importing the worker triggers main() which calls startQueue() + boss.work().
    // Our mocks prevent any real connections, and we capture the work handler.
    await import('../../src/worker');

    // Give the top-level main().catch() promise a tick to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Snapshot startup call counts before any test's beforeEach clears them
    startupStartQueueCallCount = (startQueue as jest.Mock).mock.calls.length;
    startupBossWorkCallCount = mockBoss.work.mock.calls.length;
    startupGetQueueNameCallCount = (getQueueName as jest.Mock).mock.calls.length;
    startupBossWorkArgs = mockBoss.work.mock.calls[0] ?? [];
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Startup / subscription
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Job processing — happy path
  // -----------------------------------------------------------------------

  describe('processJob — success', () => {
    const jobData = {
      jobId: 'job-uuid-456',
      pipelineId: 'pipeline-uuid-123',
      payload: { event: 'user.created', user_id: 42 },
    };

    const transformedResult = { out: 'in', event: 'user.created' };

    beforeEach(async () => {
      // 1st call: UPDATE jobs SET status = 'processing' ...
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      // 2nd call: SELECT * FROM pipelines WHERE id = $1
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_PIPELINE], 'SELECT'));

      // 3rd call: UPDATE jobs SET status = 'completed' ...
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      mockRunAction.mockReturnValue(transformedResult);

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('updates job status to processing first', () => {
      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(firstCall[1]).toContain('processing');
      expect(firstCall[1]).toContain('job-uuid-456');
    });

    it('increments the attempts counter', () => {
      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall[0]).toMatch(/attempts = attempts \+ 1/);
    });

    it('fetches the pipeline from the database', () => {
      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall[0]).toMatch(/SELECT \* FROM pipelines WHERE id/);
      expect(secondCall[1]).toEqual(['pipeline-uuid-123']);
    });

    it('calls runAction with correct parameters', () => {
      expect(mockRunAction).toHaveBeenCalledTimes(1);
      expect(mockRunAction).toHaveBeenCalledWith(
        'transform_json',
        jobData.payload,
        MOCK_PIPELINE.action_config,
        {
          pipeline_id: MOCK_PIPELINE.id,
          pipeline_name: MOCK_PIPELINE.name,
          action_type: MOCK_PIPELINE.action_type,
        }
      );
    });

    it('updates job to completed with serialised result', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(thirdCall[1]).toContain('completed');
      expect(thirdCall[1]).toContain(JSON.stringify(transformedResult));
      expect(thirdCall[1]).toContain('job-uuid-456');
    });

    it('sets completed_at timestamp', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[0]).toMatch(/completed_at = NOW\(\)/);
    });
  });

  // -----------------------------------------------------------------------
  // Job processing — pipeline not found
  // -----------------------------------------------------------------------

  describe('processJob — pipeline not found', () => {
    const jobData = {
      jobId: 'job-uuid-789',
      pipelineId: 'missing-pipeline-id',
      payload: { event: 'test' },
    };

    beforeEach(async () => {
      // 1st call: UPDATE status to processing
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      // 2nd call: SELECT pipeline — empty result
      mockQuery.mockResolvedValueOnce(mockQueryResult([], 'SELECT'));

      // 3rd call: UPDATE status to failed
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('marks the job as failed', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(thirdCall[1]).toContain('failed');
    });

    it('includes a descriptive error message', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[1]).toEqual(
        expect.arrayContaining([expect.stringContaining('missing-pipeline-id')])
      );
    });

    it('does not call runAction', () => {
      expect(mockRunAction).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Job processing — action throws
  // -----------------------------------------------------------------------

  describe('processJob — action failure', () => {
    const jobData = {
      jobId: 'job-uuid-err',
      pipelineId: 'pipeline-uuid-123',
      payload: { bad: 'data' },
    };

    beforeEach(async () => {
      // 1st call: UPDATE status to processing
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      // 2nd call: SELECT pipeline
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_PIPELINE], 'SELECT'));

      // runAction throws
      mockRunAction.mockImplementation(() => {
        throw new Error('Invalid mapping configuration');
      });

      // 3rd call: UPDATE status to failed
      mockQuery.mockResolvedValueOnce(mockQueryResult());

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('marks the job as failed', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[0]).toMatch(/UPDATE jobs SET status/);
      expect(thirdCall[1]).toContain('failed');
    });

    it('stores the error message from the thrown error', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[1]).toContain('Invalid mapping configuration');
    });

    it('does not set completed_at', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[0]).not.toMatch(/completed_at/);
    });
  });

  // -----------------------------------------------------------------------
  // Job processing — non-Error throw
  // -----------------------------------------------------------------------

  describe('processJob — non-Error thrown value', () => {
    const jobData = {
      jobId: 'job-uuid-nonerr',
      pipelineId: 'pipeline-uuid-123',
      payload: { x: 1 },
    };

    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResult());
      mockQuery.mockResolvedValueOnce(mockQueryResult([MOCK_PIPELINE], 'SELECT'));

      mockRunAction.mockImplementation(() => {
        throw 'string error'; // eslint-disable-line @typescript-eslint/only-throw-error
      });

      mockQuery.mockResolvedValueOnce(mockQueryResult());

      await capturedWorkHandler([makePgBossJob(jobData)]);
    });

    it('falls back to "Unknown error" message', () => {
      const thirdCall = mockQuery.mock.calls[2];
      expect(thirdCall[1]).toContain('Unknown error');
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    afterEach(() => {
      mockExit.mockClear();
    });

    it('process.exit mock is in place', () => {
      // Sanity check that our spy prevents actual exit
      expect(mockExit).toBeDefined();
    });
  });
});
