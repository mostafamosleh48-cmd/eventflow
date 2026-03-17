import { runAction } from '../../../src/actions/index';
import { AppError } from '../../../src/utils/errors';

import type { PipelineContext } from '../../../src/actions/index';

const MOCK_CONTEXT: PipelineContext = {
  pipeline_id: 'pipe-dispatch-001',
  pipeline_name: 'Dispatch Test Pipeline',
  action_type: 'transform_json',
};

describe('runAction (dispatcher)', () => {
  it('dispatches transform_json correctly', () => {
    const payload = { data: { user: { name: 'John' } } };
    const config = { mapping: { user_name: 'data.user.name' } };
    const context: PipelineContext = { ...MOCK_CONTEXT, action_type: 'transform_json' };

    const result = runAction('transform_json', payload, config, context);

    expect(result).toEqual({ user_name: 'John' });
  });

  it('dispatches filter_fields correctly', () => {
    const payload = { name: 'Alice', email: 'alice@test.com', age: 30 };
    const config = { mode: 'allow', fields: ['name', 'email'] };
    const context: PipelineContext = { ...MOCK_CONTEXT, action_type: 'filter_fields' };

    const result = runAction('filter_fields', payload, config, context);

    expect(result).toEqual({ name: 'Alice', email: 'alice@test.com' });
  });

  it('dispatches enrich_timestamp correctly', () => {
    const payload = { event: 'test' };
    const config = {};
    const context: PipelineContext = { ...MOCK_CONTEXT, action_type: 'enrich_timestamp' };

    const result = runAction('enrich_timestamp', payload, config, context);

    expect(result).toHaveProperty('event', 'test');
    expect(result).toHaveProperty('_meta');

    const meta = result._meta as Record<string, unknown>;
    expect(meta.pipeline_id).toBe('pipe-dispatch-001');
    expect(meta.pipeline_name).toBe('Dispatch Test Pipeline');
    expect(meta.action_type).toBe('enrich_timestamp');
    expect(meta).toHaveProperty('processed_at');
  });

  it('throws error for unknown action_type', () => {
    const payload = { data: 'test' };
    const config = {};

    expect(() => runAction('nonexistent_action', payload, config, MOCK_CONTEXT)).toThrow(AppError);

    try {
      runAction('nonexistent_action', payload, config, MOCK_CONTEXT);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).message).toMatch(/unknown action type/i);
    }
  });

  it('throws error with the unknown action type name in the message', () => {
    expect(() => runAction('bad_action', {}, {}, MOCK_CONTEXT)).toThrow(/bad_action/);
  });
});
