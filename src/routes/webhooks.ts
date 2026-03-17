import { Router } from 'express';
import type { Request, Response } from 'express';

import pool from '../db/pool';
import { enqueueJob } from '../services/queue';
import type { Job, Pipeline, WebhookResponse } from '../types/pipeline';
import { asyncHandler } from '../utils/asyncHandler';
import { NotFoundError, ValidationError } from '../utils/errors';

const router = Router();

function getParamString(param: string | string[] | undefined): string {
  if (typeof param === 'string') {
    return param;
  }
  throw new ValidationError('Invalid path parameter');
}

// POST /webhooks/:sourceToken -- Ingest webhook
router.post(
  '/:sourceToken',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const sourceToken = getParamString(req.params.sourceToken);

    // Look up pipeline by source_token
    const pipelineResult = await pool.query<Pipeline>(
      `SELECT id, name, description, source_token, action_type, action_config, is_active, created_at, updated_at
       FROM pipelines
       WHERE source_token = $1`,
      [sourceToken]
    );

    if (pipelineResult.rows.length === 0) {
      throw new NotFoundError('Pipeline', sourceToken);
    }

    const pipeline = pipelineResult.rows[0];

    if (!pipeline.is_active) {
      throw new NotFoundError('Pipeline', sourceToken);
    }

    // Validate payload exists
    const payload = req.body as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    // Insert job row
    const jobResult = await pool.query<Job>(
      `INSERT INTO jobs (pipeline_id, status, payload)
       VALUES ($1, 'pending', $2)
       RETURNING id, pipeline_id, status, payload, result, error_message, attempts, created_at, updated_at, completed_at`,
      [pipeline.id, JSON.stringify(payload)]
    );

    const job = jobResult.rows[0];

    // Enqueue job to pg-boss
    await enqueueJob(job.id, pipeline.id, payload);

    // Return 202 Accepted
    const response: WebhookResponse = {
      job_id: job.id,
      status: 'queued',
      message: 'Webhook received and queued for processing',
    };

    res.status(202).json(response);
  })
);

export { router as webhookRouter };
