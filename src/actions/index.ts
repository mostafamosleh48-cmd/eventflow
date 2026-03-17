import type { ActionType } from '../types/pipeline';
import { AppError } from '../utils/errors';
import { transformJson } from './transformJson';
import { filterFields } from './filterFields';
import { enrichTimestamp } from './enrichTimestamp';

export interface PipelineContext {
  pipeline_id: string;
  pipeline_name: string;
  action_type: ActionType;
}

export type ActionHandler = (
  payload: Record<string, unknown>,
  config: Record<string, unknown>,
  pipelineContext: PipelineContext
) => Record<string, unknown>;

const actionRegistry: Record<string, ActionHandler> = {
  transform_json: (payload, config, _ctx) => transformJson(payload, config),
  filter_fields: (payload, config, _ctx) => filterFields(payload, config),
  enrich_timestamp: (payload, config, ctx) => enrichTimestamp(payload, config, ctx),
};

export function runAction(
  actionType: string,
  payload: Record<string, unknown>,
  config: Record<string, unknown>,
  context: PipelineContext
): Record<string, unknown> {
  const handler = actionRegistry[actionType];

  if (!handler) {
    throw new AppError(`Unknown action type: "${actionType}"`, 400);
  }

  return handler(payload, config, context);
}
