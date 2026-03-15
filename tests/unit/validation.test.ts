import { AppError } from '../../src/utils/errors';
import {
  validateCreatePipelineInput,
  validateUpdatePipelineInput,
} from '../../src/utils/validation';

// Note: ValidationError extends AppError which calls Object.setPrototypeOf(this, AppError.prototype).
// This means `instanceof ValidationError` will not work at runtime. We use a helper to assert
// that the thrown error is an AppError with statusCode 400 (i.e., a validation error).
function expectValidationError(fn: () => unknown, messagePattern?: RegExp): void {
  try {
    fn();
    throw new Error('Expected function to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    if (messagePattern) {
      expect((err as AppError).message).toMatch(messagePattern);
    }
  }
}

describe('validateCreatePipelineInput', () => {
  const validInput = {
    name: 'My Pipeline',
    description: 'A test pipeline',
    action_type: 'transform_json',
    action_config: { mapping: { out: 'in' } },
    subscribers: [{ url: 'https://example.com/hook', headers: { Authorization: 'Bearer abc' } }],
  };

  it('returns typed output when all fields are provided', () => {
    const result = validateCreatePipelineInput(validInput);

    expect(result).toEqual({
      name: 'My Pipeline',
      description: 'A test pipeline',
      action_type: 'transform_json',
      action_config: { mapping: { out: 'in' } },
      subscribers: [{ url: 'https://example.com/hook', headers: { Authorization: 'Bearer abc' } }],
    });
  });

  it('returns typed output with only required fields', () => {
    const result = validateCreatePipelineInput({
      name: 'Minimal Pipeline',
      action_type: 'filter_fields',
    });

    expect(result).toEqual({
      name: 'Minimal Pipeline',
      action_type: 'filter_fields',
    });
  });

  it('trims whitespace from name', () => {
    const result = validateCreatePipelineInput({
      name: '  Trimmed  ',
      action_type: 'transform_json',
    });

    expect(result.name).toBe('Trimmed');
  });

  it('throws ValidationError when name is missing', () => {
    expectValidationError(
      () => validateCreatePipelineInput({ action_type: 'transform_json' }),
      /name is required/i
    );
  });

  it('throws ValidationError when name is an empty string', () => {
    expectValidationError(
      () => validateCreatePipelineInput({ name: '', action_type: 'transform_json' }),
      /name is required/i
    );
    expectValidationError(
      () => validateCreatePipelineInput({ name: '   ', action_type: 'transform_json' }),
      /name is required/i
    );
  });

  it('throws ValidationError when action_type is missing', () => {
    expectValidationError(
      () => validateCreatePipelineInput({ name: 'Pipeline' }),
      /action_type is required/i
    );
  });

  it('throws ValidationError when action_type is invalid', () => {
    expectValidationError(
      () => validateCreatePipelineInput({ name: 'Pipeline', action_type: 'invalid_action' }),
      /action_type/i
    );
  });

  it('accepts a valid action_config object', () => {
    const result = validateCreatePipelineInput({
      name: 'Pipeline',
      action_type: 'enrich_timestamp',
      action_config: { timezone: 'UTC' },
    });

    expect(result.action_config).toEqual({ timezone: 'UTC' });
  });

  it('throws ValidationError when action_config is not an object', () => {
    expectValidationError(
      () =>
        validateCreatePipelineInput({
          name: 'Pipeline',
          action_type: 'transform_json',
          action_config: 'not-an-object',
        }),
      /action_config must be a JSON object/i
    );
    expectValidationError(
      () =>
        validateCreatePipelineInput({
          name: 'Pipeline',
          action_type: 'transform_json',
          action_config: 42,
        }),
      /action_config must be a JSON object/i
    );
  });

  it('throws ValidationError when action_config is an array', () => {
    expectValidationError(
      () =>
        validateCreatePipelineInput({
          name: 'Pipeline',
          action_type: 'transform_json',
          action_config: [1, 2, 3],
        }),
      /action_config must be a JSON object/i
    );
  });

  it('accepts a valid subscribers array', () => {
    const result = validateCreatePipelineInput({
      name: 'Pipeline',
      action_type: 'transform_json',
      subscribers: [
        { url: 'https://example.com/a' },
        { url: 'https://example.com/b', headers: { 'X-Key': 'val' } },
      ],
    });

    expect(result.subscribers).toHaveLength(2);
    expect(result.subscribers?.[0]).toEqual({ url: 'https://example.com/a' });
    expect(result.subscribers?.[1]).toEqual({
      url: 'https://example.com/b',
      headers: { 'X-Key': 'val' },
    });
  });

  it('throws ValidationError when a subscriber is missing url', () => {
    expectValidationError(
      () =>
        validateCreatePipelineInput({
          name: 'Pipeline',
          action_type: 'transform_json',
          subscribers: [{ headers: {} }],
        }),
      /subscribers\[0\]\.url/i
    );
  });

  it('throws ValidationError when subscriber url is not a string', () => {
    expectValidationError(
      () =>
        validateCreatePipelineInput({
          name: 'Pipeline',
          action_type: 'transform_json',
          subscribers: [{ url: 12345 }],
        }),
      /subscribers\[0\]\.url/i
    );
  });

  it('throws ValidationError when subscriber url is an invalid URL string', () => {
    expectValidationError(
      () =>
        validateCreatePipelineInput({
          name: 'Pipeline',
          action_type: 'transform_json',
          subscribers: [{ url: 'not-a-url' }],
        }),
      /subscribers\[0\]\.url/i
    );
  });

  it('throws ValidationError when body is not an object', () => {
    expectValidationError(
      () => validateCreatePipelineInput('a string'),
      /request body must be a json object/i
    );
    expectValidationError(() => validateCreatePipelineInput(42));
    expectValidationError(() => validateCreatePipelineInput(true));
  });

  it('throws ValidationError when body is null', () => {
    expectValidationError(
      () => validateCreatePipelineInput(null),
      /request body must be a json object/i
    );
  });

  it('throws ValidationError when body is an array', () => {
    expectValidationError(
      () => validateCreatePipelineInput([1, 2]),
      /request body must be a json object/i
    );
  });

  it('throws ValidationError when body is undefined', () => {
    expectValidationError(
      () => validateCreatePipelineInput(undefined),
      /request body must be a json object/i
    );
  });

  it('accepts all valid action types', () => {
    for (const actionType of ['transform_json', 'filter_fields', 'enrich_timestamp']) {
      const result = validateCreatePipelineInput({
        name: 'Pipeline',
        action_type: actionType,
      });
      expect(result.action_type).toBe(actionType);
    }
  });

  it('throws an error with statusCode 400', () => {
    expectValidationError(() => validateCreatePipelineInput({}));
  });
});

describe('validateUpdatePipelineInput', () => {
  it('returns typed output for a partial update with just name', () => {
    const result = validateUpdatePipelineInput({ name: 'Updated Name' });

    expect(result).toEqual({ name: 'Updated Name' });
  });

  it('returns typed output for a partial update with multiple fields', () => {
    const result = validateUpdatePipelineInput({
      name: 'New Name',
      description: 'New description',
      action_type: 'filter_fields',
      is_active: false,
    });

    expect(result).toEqual({
      name: 'New Name',
      description: 'New description',
      action_type: 'filter_fields',
      is_active: false,
    });
  });

  it('throws ValidationError for an empty object (no fields provided)', () => {
    expectValidationError(() => validateUpdatePipelineInput({}), /at least one field/i);
  });

  it('throws ValidationError when action_type is invalid', () => {
    expectValidationError(
      () => validateUpdatePipelineInput({ action_type: 'not_valid' }),
      /action_type must be one of/i
    );
  });

  it('throws ValidationError when is_active is not a boolean', () => {
    expectValidationError(
      () => validateUpdatePipelineInput({ is_active: 'yes' }),
      /is_active must be a boolean/i
    );
    expectValidationError(
      () => validateUpdatePipelineInput({ is_active: 1 }),
      /is_active must be a boolean/i
    );
  });

  it('throws ValidationError when body is not an object', () => {
    expectValidationError(
      () => validateUpdatePipelineInput('a string'),
      /request body must be a json object/i
    );
    expectValidationError(() => validateUpdatePipelineInput(42));
    expectValidationError(() => validateUpdatePipelineInput(true));
  });

  it('throws ValidationError when body is null', () => {
    expectValidationError(
      () => validateUpdatePipelineInput(null),
      /request body must be a json object/i
    );
  });

  it('throws ValidationError when name is an empty string', () => {
    expectValidationError(
      () => validateUpdatePipelineInput({ name: '' }),
      /name must be a non-empty string/i
    );
    expectValidationError(
      () => validateUpdatePipelineInput({ name: '   ' }),
      /name must be a non-empty string/i
    );
  });

  it('throws ValidationError when action_config is not an object', () => {
    expectValidationError(
      () => validateUpdatePipelineInput({ action_config: 'bad' }),
      /action_config must be a JSON object/i
    );
    expectValidationError(
      () => validateUpdatePipelineInput({ action_config: 123 }),
      /action_config must be a JSON object/i
    );
  });

  it('trims whitespace from name', () => {
    const result = validateUpdatePipelineInput({ name: '  Trimmed  ' });

    expect(result.name).toBe('Trimmed');
  });

  it('accepts valid action_config in update', () => {
    const result = validateUpdatePipelineInput({
      action_config: { key: 'value' },
    });

    expect(result.action_config).toEqual({ key: 'value' });
  });

  it('accepts is_active as true or false', () => {
    expect(validateUpdatePipelineInput({ is_active: true })).toEqual({ is_active: true });
    expect(validateUpdatePipelineInput({ is_active: false })).toEqual({ is_active: false });
  });

  it('throws an error with statusCode 400', () => {
    expectValidationError(() => validateUpdatePipelineInput('not an object'));
  });
});
