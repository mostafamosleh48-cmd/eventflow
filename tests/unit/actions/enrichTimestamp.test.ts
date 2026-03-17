import { enrichTimestamp } from '../../../src/actions/enrichTimestamp';

import type { PipelineContext } from '../../../src/actions/index';

const MOCK_CONTEXT: PipelineContext = {
  pipeline_id: 'pipe-003',
  pipeline_name: 'Enrich Pipeline',
  action_type: 'enrich_timestamp',
};

describe('enrichTimestamp', () => {
  it('adds _meta block to payload', () => {
    const payload = { event: 'user.created' };
    const config = {};

    const result = enrichTimestamp(payload, config, MOCK_CONTEXT);

    expect(result).toHaveProperty('_meta');
    expect(typeof result._meta).toBe('object');
  });

  it('_meta contains processed_at as a valid ISO string', () => {
    const before = new Date().toISOString();
    const result = enrichTimestamp({ event: 'test' }, {}, MOCK_CONTEXT);
    const after = new Date().toISOString();

    const meta = result._meta as Record<string, unknown>;
    const processedAt = meta.processed_at as string;

    // Verify it's a valid ISO string by parsing it
    expect(() => new Date(processedAt)).not.toThrow();
    expect(new Date(processedAt).toISOString()).toBe(processedAt);

    // Verify the timestamp is within the expected range
    expect(processedAt >= before).toBe(true);
    expect(processedAt <= after).toBe(true);
  });

  it('_meta contains pipeline_id from context', () => {
    const result = enrichTimestamp({ event: 'test' }, {}, MOCK_CONTEXT);

    const meta = result._meta as Record<string, unknown>;
    expect(meta.pipeline_id).toBe('pipe-003');
  });

  it('_meta contains pipeline_name from context', () => {
    const result = enrichTimestamp({ event: 'test' }, {}, MOCK_CONTEXT);

    const meta = result._meta as Record<string, unknown>;
    expect(meta.pipeline_name).toBe('Enrich Pipeline');
  });

  it('_meta contains action_type from context', () => {
    const result = enrichTimestamp({ event: 'test' }, {}, MOCK_CONTEXT);

    const meta = result._meta as Record<string, unknown>;
    expect(meta.action_type).toBe('enrich_timestamp');
  });

  it('preserves existing payload fields', () => {
    const payload = {
      event: 'user.created',
      user_id: 42,
      details: { role: 'admin' },
    };

    const result = enrichTimestamp(payload, {}, MOCK_CONTEXT);

    expect(result.event).toBe('user.created');
    expect(result.user_id).toBe(42);
    expect(result.details).toEqual({ role: 'admin' });
    expect(result).toHaveProperty('_meta');
  });

  it('works with empty payload', () => {
    const result = enrichTimestamp({}, {}, MOCK_CONTEXT);

    expect(result).toHaveProperty('_meta');

    const meta = result._meta as Record<string, unknown>;
    expect(meta.pipeline_id).toBe('pipe-003');
    expect(meta.pipeline_name).toBe('Enrich Pipeline');
    expect(meta.action_type).toBe('enrich_timestamp');
    expect(meta).toHaveProperty('processed_at');

    // Only _meta should be present
    const keys = Object.keys(result);
    expect(keys).toEqual(['_meta']);
  });

  it('uses context values from different pipelines correctly', () => {
    const customContext: PipelineContext = {
      pipeline_id: 'custom-id-999',
      pipeline_name: 'Custom Pipeline',
      action_type: 'enrich_timestamp',
    };

    const result = enrichTimestamp({ key: 'val' }, {}, customContext);
    const meta = result._meta as Record<string, unknown>;

    expect(meta.pipeline_id).toBe('custom-id-999');
    expect(meta.pipeline_name).toBe('Custom Pipeline');
  });
});
