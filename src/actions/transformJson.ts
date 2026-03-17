import { ValidationError } from '../utils/errors';

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current ?? null;
}

export function transformJson(
  payload: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, unknown> {
  const mapping = config.mapping;

  if (mapping === undefined || mapping === null) {
    throw new ValidationError('transform_json requires a "mapping" object in action_config');
  }

  if (typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new ValidationError('"mapping" must be a Record<string, string>');
  }

  const typedMapping = mapping as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [outputKey, pathValue] of Object.entries(typedMapping)) {
    if (typeof pathValue !== 'string') {
      throw new ValidationError(
        `mapping value for "${outputKey}" must be a string dot-notation path`
      );
    }
    result[outputKey] = getNestedValue(payload, pathValue);
  }

  return result;
}
