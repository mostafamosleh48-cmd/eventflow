CREATE TABLE pipelines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  source_token  TEXT UNIQUE NOT NULL,
  action_type   TEXT NOT NULL,
  action_config JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipelines_source_token ON pipelines (source_token);
CREATE INDEX idx_pipelines_is_active ON pipelines (is_active);
