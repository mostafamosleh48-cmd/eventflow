import { transformJson } from '../../../src/actions/transformJson';
import { AppError } from '../../../src/utils/errors';

describe('transformJson', () => {
  it('maps fields using dot notation', () => {
    const payload = { data: { user: { name: 'John' } } };
    const config = { mapping: { user_name: 'data.user.name' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ user_name: 'John' });
  });

  it('maps nested paths correctly (multiple levels deep)', () => {
    const payload = {
      a: {
        b: {
          c: {
            d: 'deep-value',
          },
        },
      },
    };
    const config = { mapping: { output: 'a.b.c.d' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ output: 'deep-value' });
  });

  it('returns null for missing paths', () => {
    const payload = { data: { user: { name: 'John' } } };
    const config = { mapping: { email: 'data.user.email' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ email: null });
  });

  it('returns null for undefined paths (intermediate key missing)', () => {
    const payload = { data: { profile: {} } };
    const config = { mapping: { value: 'data.nonexistent.key' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ value: null });
  });

  it('throws ValidationError when mapping is missing from config', () => {
    const payload = { key: 'value' };
    const config = {};

    expect(() => transformJson(payload, config)).toThrow(AppError);
    try {
      transformJson(payload, config);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
    }
  });

  it('throws ValidationError when mapping is null', () => {
    const payload = { key: 'value' };
    const config = { mapping: null };

    expect(() => transformJson(payload, config)).toThrow(AppError);
  });

  it('returns empty object when mapping is an empty object', () => {
    const payload = { data: { user: { name: 'John' } } };
    const config = { mapping: {} };

    const result = transformJson(payload, config);

    expect(result).toEqual({});
  });

  it('maps a top-level field (no dots in path)', () => {
    const payload = { name: 'Alice', age: 30 };
    const config = { mapping: { full_name: 'name' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ full_name: 'Alice' });
  });

  it('handles array value at path (returns the array as-is)', () => {
    const payload = { data: { tags: ['a', 'b', 'c'] } };
    const config = { mapping: { all_tags: 'data.tags' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ all_tags: ['a', 'b', 'c'] });
  });

  it('maps multiple fields at once', () => {
    const payload = {
      user: { first: 'Jane', last: 'Doe' },
      meta: { source: 'api' },
    };
    const config = {
      mapping: {
        first_name: 'user.first',
        last_name: 'user.last',
        origin: 'meta.source',
      },
    };

    const result = transformJson(payload, config);

    expect(result).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      origin: 'api',
    });
  });

  it('does not include fields from payload that are not in the mapping', () => {
    const payload = { keep: 'yes', discard: 'no' };
    const config = { mapping: { kept: 'keep' } };

    const result = transformJson(payload, config);

    expect(result).toEqual({ kept: 'yes' });
    expect(result).not.toHaveProperty('discard');
  });
});
