CREATE TABLE delivery_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs(id),
  subscriber_id  UUID NOT NULL REFERENCES subscribers(id),
  status_code    INT,
  success        BOOLEAN NOT NULL,
  response_body  TEXT,
  attempt_number INT NOT NULL DEFAULT 1,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delivery_attempts_job_id ON delivery_attempts (job_id);
CREATE INDEX idx_delivery_attempts_subscriber_id ON delivery_attempts (subscriber_id);
