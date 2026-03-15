import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';

import pool from '../db/pool';
import type {
  Pipeline,
  PipelineResponse,
  PipelineListResponse,
  Subscriber,
} from '../types/pipeline';
import { asyncHandler } from '../utils/asyncHandler';
import { NotFoundError, ValidationError } from '../utils/errors';
import { validateCreatePipelineInput, validateUpdatePipelineInput } from '../utils/validation';

function getParamString(param: string | string[] | undefined): string {
  if (typeof param === 'string') {
    return param;
  }
  throw new ValidationError('Invalid path parameter');
}

const router = Router();

function buildSourceUrl(req: Request, sourceToken: string): string {
  return `${req.protocol}://${req.get('host')}/webhooks/${sourceToken}`;
}

async function fetchSubscribers(pipelineId: string): Promise<Subscriber[]> {
  const result = await pool.query<Subscriber>(
    'SELECT id, pipeline_id, url, headers, created_at FROM subscribers WHERE pipeline_id = $1 ORDER BY created_at',
    [pipelineId]
  );
  return result.rows;
}

function toPipelineResponse(
  pipeline: Pipeline,
  subscribers: Subscriber[],
  sourceUrl: string
): PipelineResponse {
  return {
    ...pipeline,
    source_url: sourceUrl,
    subscribers,
  };
}

// POST /api/v1/pipelines — Create pipeline
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const input = validateCreatePipelineInput(req.body);
    const sourceToken = randomUUID();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const pipelineResult = await client.query<Pipeline>(
        `INSERT INTO pipelines (name, description, source_token, action_type, action_config)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, source_token, action_type, action_config, is_active, created_at, updated_at`,
        [
          input.name,
          input.description ?? null,
          sourceToken,
          input.action_type,
          JSON.stringify(input.action_config ?? {}),
        ]
      );
      const pipeline = pipelineResult.rows[0];

      const subscribers: Subscriber[] = [];
      if (input.subscribers && input.subscribers.length > 0) {
        for (const sub of input.subscribers) {
          const subResult = await client.query<Subscriber>(
            `INSERT INTO subscribers (pipeline_id, url, headers)
             VALUES ($1, $2, $3)
             RETURNING id, pipeline_id, url, headers, created_at`,
            [pipeline.id, sub.url, JSON.stringify(sub.headers ?? {})]
          );
          subscribers.push(subResult.rows[0]);
        }
      }

      await client.query('COMMIT');

      const sourceUrl = buildSourceUrl(req, pipeline.source_token);
      res.status(201).json(toPipelineResponse(pipeline, subscribers, sourceUrl));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// GET /api/v1/pipelines — List pipelines
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
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

    const countResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pipelines'
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const pipelinesResult = await pool.query<Pipeline>(
      `SELECT id, name, description, source_token, action_type, action_config, is_active, created_at, updated_at
       FROM pipelines
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const data: PipelineResponse[] = [];
    for (const pipeline of pipelinesResult.rows) {
      const subscribers = await fetchSubscribers(pipeline.id);
      const sourceUrl = buildSourceUrl(req, pipeline.source_token);
      data.push(toPipelineResponse(pipeline, subscribers, sourceUrl));
    }

    const response: PipelineListResponse = { data, total, limit, offset };
    res.json(response);
  })
);

// GET /api/v1/pipelines/:id — Get single pipeline
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = getParamString(req.params.id);

    const result = await pool.query<Pipeline>(
      `SELECT id, name, description, source_token, action_type, action_config, is_active, created_at, updated_at
       FROM pipelines
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Pipeline', id);
    }

    const pipeline = result.rows[0];
    const subscribers = await fetchSubscribers(pipeline.id);
    const sourceUrl = buildSourceUrl(req, pipeline.source_token);

    res.json(toPipelineResponse(pipeline, subscribers, sourceUrl));
  })
);

// PATCH /api/v1/pipelines/:id — Update pipeline
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = getParamString(req.params.id);
    const input = validateUpdatePipelineInput(req.body);

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(input.description);
    }
    if (input.action_type !== undefined) {
      setClauses.push(`action_type = $${paramIndex++}`);
      values.push(input.action_type);
    }
    if (input.action_config !== undefined) {
      setClauses.push(`action_config = $${paramIndex++}`);
      values.push(JSON.stringify(input.action_config));
    }
    if (input.is_active !== undefined) {
      setClauses.push(`is_active = $${paramIndex++}`);
      values.push(input.is_active);
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query<Pipeline>(
      `UPDATE pipelines
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, name, description, source_token, action_type, action_config, is_active, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Pipeline', id);
    }

    const pipeline = result.rows[0];
    const subscribers = await fetchSubscribers(pipeline.id);
    const sourceUrl = buildSourceUrl(req, pipeline.source_token);

    res.json(toPipelineResponse(pipeline, subscribers, sourceUrl));
  })
);

// DELETE /api/v1/pipelines/:id — Delete pipeline
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = getParamString(req.params.id);

    const result = await pool.query('DELETE FROM pipelines WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      throw new NotFoundError('Pipeline', id);
    }

    res.status(204).send();
  })
);

export { router as pipelineRouter };
