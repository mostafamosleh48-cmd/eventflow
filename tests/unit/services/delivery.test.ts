import pool from '../../../src/db/pool';
import {
  calculateDeliveryRetryDelaySeconds,
  deliverToSubscriber,
  DELIVERY_BACKOFF_SCHEDULE_SECONDS,
} from '../../../src/services/delivery';
import type { Subscriber } from '../../../src/types/pipeline';

jest.mock('../../../src/db/pool', () => {
  const mockPool = {
    query: jest.fn(),
  };
  return { __esModule: true, default: mockPool };
});

const mockQuery = pool.query as jest.Mock;

const subscriber: Subscriber = {
  id: 'subscriber-1',
  pipeline_id: 'pipeline-1',
  url: 'https://example.com/hook',
  headers: { 'X-Test': 'yes' },
  created_at: new Date().toISOString(),
};

describe('delivery service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats 2xx response as success and records attempt', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 201,
      text: jest.fn().mockResolvedValue('created'),
    } as unknown as Response);

    const result = await deliverToSubscriber('job-1', subscriber, { ok: true }, 1);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      subscriber.url,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Test': 'yes',
        }),
      })
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual(['job-1', 'subscriber-1', 201, true, 'created', 1]);

    fetchMock.mockRestore();
  });

  it('treats non-2xx response as failure and records attempt', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 500,
      text: jest.fn().mockResolvedValue('server error'),
    } as unknown as Response);

    const result = await deliverToSubscriber('job-2', subscriber, { ok: false }, 2);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(mockQuery.mock.calls[0][1]).toEqual([
      'job-2',
      'subscriber-1',
      500,
      false,
      'server error',
      2,
    ]);

    fetchMock.mockRestore();
  });

  it('handles timeout/abort as failure and records attempt', async () => {
    const abortError = new Error('The operation was aborted') as Error & { name: string };
    abortError.name = 'AbortError';

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const result = await deliverToSubscriber('job-3', subscriber, { timeout: true }, 3);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.responseBody).toMatch(/timed out/i);
    expect(mockQuery.mock.calls[0][1][2]).toBeNull();
    expect(mockQuery.mock.calls[0][1][3]).toBe(false);
    expect(mockQuery.mock.calls[0][1][5]).toBe(3);

    fetchMock.mockRestore();
  });
});

describe('calculateDeliveryRetryDelaySeconds', () => {
  it('returns configured exponential backoff schedule', () => {
    expect(calculateDeliveryRetryDelaySeconds(1)).toBe(DELIVERY_BACKOFF_SCHEDULE_SECONDS[0]);
    expect(calculateDeliveryRetryDelaySeconds(2)).toBe(DELIVERY_BACKOFF_SCHEDULE_SECONDS[1]);
    expect(calculateDeliveryRetryDelaySeconds(3)).toBe(DELIVERY_BACKOFF_SCHEDULE_SECONDS[2]);
    expect(calculateDeliveryRetryDelaySeconds(4)).toBe(DELIVERY_BACKOFF_SCHEDULE_SECONDS[3]);
    expect(calculateDeliveryRetryDelaySeconds(5)).toBe(DELIVERY_BACKOFF_SCHEDULE_SECONDS[4]);
  });

  it('returns null outside supported retry range', () => {
    expect(calculateDeliveryRetryDelaySeconds(0)).toBeNull();
    expect(calculateDeliveryRetryDelaySeconds(6)).toBeNull();
    expect(calculateDeliveryRetryDelaySeconds(-1)).toBeNull();
  });
});
