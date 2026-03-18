import { Router } from 'express';
import type { Request, Response } from 'express';

import pool from '../db/pool';
import type { Job } from '../types/pipeline';
import { asyncHandler } from '../utils/asyncHandler';
import { NotFoundError, ValidationError } from '../utils/errors';

interface JobListResponse {
  data: Job[];
  total: number;
  limit: number;
  offset: number;
}

interface JobDeliveryAttempt {
  id: string;
  job_id: string;
  subscriber_id: string;
  subscriber_url: string;
  status_code: number | null;
  success: boolean;
  response_body: string | null;
  attempt_number: number;
  attempted_at: string;
}

interface JobDeliveriesResponse {
  job_id: string;
  deliveries: JobDeliveryAttempt[];
}

function getParamString(param: string | string[] | undefined): string {
  if (typeof param === 'string') {
    return param;
  }
  throw new ValidationError('Invalid path parameter');
}

const router = Router();

// GET /api/v1/jobs/:id — Get single job
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = getParamString(req.params.id);

    const result = await pool.query<Job>(
      `SELECT id, pipeline_id, status, payload, result, error_message, attempts, created_at, updated_at, completed_at
       FROM jobs
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Job', id);
    }

    res.json(result.rows[0]);
  })
);

// GET /api/v1/jobs — List jobs with filters
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const pipelineId =
      typeof req.query.pipeline_id === 'string' ? req.query.pipeline_id : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    let limit = parseInt(req.query.limit as string, 10);
    let offset = parseInt(req.query.offset as string, 10);

    if (isNaN(limit) || limit < 1) {
      limit = 20;
    }
    if (limit > 100) {
      limit = 100;
    }
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (pipelineId) {
      whereClauses.push(`pipeline_id = $${paramIndex++}`);
      values.push(pipelineId);
    }

    if (status) {
      whereClauses.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM jobs
       ${whereSql}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const listValues = [...values, limit, offset];
    const jobsResult = await pool.query<Job>(
      `SELECT id, pipeline_id, status, payload, result, error_message, attempts, created_at, updated_at, completed_at
       FROM jobs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      listValues
    );

    const response: JobListResponse = {
      data: jobsResult.rows,
      total,
      limit,
      offset,
    };

    res.json(response);
  })
);

// GET /api/v1/jobs/:id/deliveries — Get delivery attempts for job
router.get(
  '/:id/deliveries',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = getParamString(req.params.id);

    const jobResult = await pool.query<Pick<Job, 'id'>>('SELECT id FROM jobs WHERE id = $1', [id]);
    if (jobResult.rows.length === 0) {
      throw new NotFoundError('Job', id);
    }

    const attemptsResult = await pool.query<JobDeliveryAttempt>(
      `SELECT da.id, da.job_id, da.subscriber_id, s.url AS subscriber_url, da.status_code, da.success,
              da.response_body, da.attempt_number, da.attempted_at
       FROM delivery_attempts da
       INNER JOIN subscribers s ON s.id = da.subscriber_id
       WHERE da.job_id = $1
       ORDER BY da.attempt_number ASC, da.attempted_at ASC`,
      [id]
    );

    const response: JobDeliveriesResponse = {
      job_id: id,
      deliveries: attemptsResult.rows,
    };

    res.json(response);
  })
);

export { router as jobsRouter };
