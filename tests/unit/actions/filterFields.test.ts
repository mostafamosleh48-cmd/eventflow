import { filterFields } from '../../../src/actions/filterFields';
import { AppError } from '../../../src/utils/errors';

describe('filterFields', () => {
  it('allow mode: keeps only listed fields', () => {
    const payload = { name: 'Alice', email: 'alice@test.com', age: 30 };
    const config = { mode: 'allow', fields: ['name', 'email'] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ name: 'Alice', email: 'alice@test.com' });
  });

  it('allow mode: handles fields that do not exist in payload', () => {
    const payload = { name: 'Alice' };
    const config = { mode: 'allow', fields: ['name', 'nonexistent'] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ name: 'Alice' });
    expect(result).not.toHaveProperty('nonexistent');
  });

  it('block mode: removes listed fields, keeps rest', () => {
    const payload = { name: 'Alice', email: 'alice@test.com', age: 30 };
    const config = { mode: 'block', fields: ['email'] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('block mode: handles fields that do not exist in payload', () => {
    const payload = { name: 'Alice', age: 30 };
    const config = { mode: 'block', fields: ['nonexistent'] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('defaults to allow mode when mode is not specified', () => {
    const payload = { name: 'Alice', email: 'alice@test.com', age: 30 };
    const config = { fields: ['name'] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ name: 'Alice' });
  });

  it('empty fields array in allow mode returns empty object', () => {
    const payload = { name: 'Alice', age: 30 };
    const config = { mode: 'allow', fields: [] as string[] };

    const result = filterFields(payload, config);

    expect(result).toEqual({});
  });

  it('empty fields array in block mode keeps all fields', () => {
    const payload = { name: 'Alice', age: 30 };
    const config = { mode: 'block', fields: [] as string[] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('throws ValidationError when fields is not an array', () => {
    const payload = { name: 'Alice' };
    const config = { mode: 'allow', fields: 'name' };

    expect(() => filterFields(payload, config)).toThrow(AppError);
    try {
      filterFields(payload, config);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
    }
  });

  it('throws ValidationError when fields is missing from config', () => {
    const payload = { name: 'Alice' };
    const config = { mode: 'allow' };

    expect(() => filterFields(payload, config)).toThrow(AppError);
  });

  it('defaults to allow mode when mode is an invalid value', () => {
    const payload = { name: 'Alice', email: 'alice@test.com' };
    const config = { mode: 'invalid_mode', fields: ['name'] };

    const result = filterFields(payload, config);

    // Invalid mode falls through to default 'allow' behavior
    expect(result).toEqual({ name: 'Alice' });
  });

  it('works on top-level fields only', () => {
    const payload = { user: { name: 'Alice', age: 30 }, status: 'active' };
    const config = { mode: 'allow', fields: ['user'] };

    const result = filterFields(payload, config);

    expect(result).toEqual({ user: { name: 'Alice', age: 30 } });
    expect(result).not.toHaveProperty('status');
  });
});
