import { ValidationError } from '../utils/errors';

type FilterMode = 'allow' | 'block';

function isValidMode(value: unknown): value is FilterMode {
  return value === 'allow' || value === 'block';
}

export function filterFields(
  payload: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, unknown> {
  const fields = config.fields;

  if (!Array.isArray(fields)) {
    throw new ValidationError('filter_fields requires a "fields" array in action_config');
  }

  const fieldNames = fields.filter((f): f is string => typeof f === 'string');

  const mode: FilterMode =
    config.mode !== undefined && isValidMode(config.mode) ? config.mode : 'allow';

  const fieldSet = new Set(fieldNames);

  if (mode === 'allow') {
    const result: Record<string, unknown> = {};
    for (const key of fieldSet) {
      if (key in payload) {
        result[key] = payload[key];
      }
    }
    return result;
  }

  // block mode
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!fieldSet.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
