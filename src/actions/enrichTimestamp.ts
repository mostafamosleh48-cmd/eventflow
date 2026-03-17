import type { PipelineContext } from './index';

export function enrichTimestamp(
  payload: Record<string, unknown>,
  _config: Record<string, unknown>,
  pipelineContext: PipelineContext
): Record<string, unknown> {
  return {
    ...payload,
    _meta: {
      processed_at: new Date().toISOString(),
      pipeline_id: pipelineContext.pipeline_id,
      pipeline_name: pipelineContext.pipeline_name,
      action_type: pipelineContext.action_type,
    },
  };
}
