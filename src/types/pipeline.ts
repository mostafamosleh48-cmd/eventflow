// Valid action types for pipeline processing
export const VALID_ACTION_TYPES = ['transform_json', 'filter_fields', 'enrich_timestamp'] as const;

export type ActionType = (typeof VALID_ACTION_TYPES)[number];

// --- Database row types ---

export interface Pipeline {
  id: string;
  name: string;
  description: string | null;
  source_token: string;
  action_type: ActionType;
  action_config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Subscriber {
  id: string;
  pipeline_id: string;
  url: string;
  headers: Record<string, string>;
  created_at: string;
}

// --- API request types ---

export interface CreateSubscriberInput {
  url: string;
  headers?: Record<string, string>;
}

export interface CreatePipelineInput {
  name: string;
  description?: string;
  action_type: ActionType;
  action_config?: Record<string, unknown>;
  subscribers?: CreateSubscriberInput[];
}

export interface UpdatePipelineInput {
  name?: string;
  description?: string;
  action_type?: ActionType;
  action_config?: Record<string, unknown>;
  is_active?: boolean;
}

// --- API response types ---

export interface PipelineResponse extends Pipeline {
  source_url: string;
  subscribers: Subscriber[];
}

export interface PipelineListResponse {
  data: PipelineResponse[];
  total: number;
  limit: number;
  offset: number;
}

// --- Job types ---

export interface Job {
  id: string;
  pipeline_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WebhookResponse {
  job_id: string;
  status: string;
  message: string;
}
