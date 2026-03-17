import { VALID_ACTION_TYPES } from '../types/pipeline';
import type { ActionType, CreatePipelineInput, UpdatePipelineInput } from '../types/pipeline';
import { ValidationError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (VALID_ACTION_TYPES as readonly string[]).includes(value);
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === 'string');
}

export function validateCreatePipelineInput(body: unknown): CreatePipelineInput {
  if (!isRecord(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const { name, description, action_type, action_config, subscribers } = body;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('name is required and must be a non-empty string');
  }

  if (description !== undefined && typeof description !== 'string') {
    throw new ValidationError('description must be a string');
  }

  if (!isValidActionType(action_type)) {
    throw new ValidationError(
      `action_type is required and must be one of: ${VALID_ACTION_TYPES.join(', ')}`
    );
  }

  if (action_config !== undefined && !isRecord(action_config)) {
    throw new ValidationError('action_config must be a JSON object');
  }

  if (subscribers !== undefined) {
    if (!Array.isArray(subscribers)) {
      throw new ValidationError('subscribers must be an array');
    }

    for (let i = 0; i < subscribers.length; i++) {
      const sub: unknown = subscribers[i];
      if (!isRecord(sub)) {
        throw new ValidationError(`subscribers[${i}] must be a JSON object`);
      }
      if (typeof sub.url !== 'string' || !isValidUrl(sub.url)) {
        throw new ValidationError(`subscribers[${i}].url must be a valid URL`);
      }
      if (sub.headers !== undefined && !isStringRecord(sub.headers)) {
        throw new ValidationError(`subscribers[${i}].headers must be an object with string values`);
      }
    }
  }

  const input: CreatePipelineInput = {
    name: name.trim(),
    action_type,
  };

  if (description !== undefined) {
    input.description = description;
  }

  if (action_config !== undefined) {
    input.action_config = action_config;
  }

  if (subscribers !== undefined) {
    input.subscribers = (subscribers as Record<string, unknown>[]).map((sub) => ({
      url: sub.url as string,
      ...(sub.headers !== undefined ? { headers: sub.headers as Record<string, string> } : {}),
    }));
  }

  return input;
}

export function validateUpdatePipelineInput(body: unknown): UpdatePipelineInput {
  if (!isRecord(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const { name, description, action_type, action_config, is_active } = body;

  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    throw new ValidationError('name must be a non-empty string');
  }

  if (description !== undefined && typeof description !== 'string') {
    throw new ValidationError('description must be a string');
  }

  if (action_type !== undefined && !isValidActionType(action_type)) {
    throw new ValidationError(`action_type must be one of: ${VALID_ACTION_TYPES.join(', ')}`);
  }

  if (action_config !== undefined && !isRecord(action_config)) {
    throw new ValidationError('action_config must be a JSON object');
  }

  if (is_active !== undefined && typeof is_active !== 'boolean') {
    throw new ValidationError('is_active must be a boolean');
  }

  const hasFields =
    name !== undefined ||
    description !== undefined ||
    action_type !== undefined ||
    action_config !== undefined ||
    is_active !== undefined;

  if (!hasFields) {
    throw new ValidationError(
      'At least one field must be provided: name, description, action_type, action_config, is_active'
    );
  }

  const input: UpdatePipelineInput = {};

  if (name !== undefined) {
    input.name = name.trim();
  }
  if (description !== undefined) {
    input.description = description;
  }
  if (action_type !== undefined) {
    input.action_type = action_type;
  }
  if (action_config !== undefined) {
    input.action_config = action_config;
  }
  if (is_active !== undefined) {
    input.is_active = is_active;
  }

  return input;
}
