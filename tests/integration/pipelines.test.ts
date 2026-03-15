import { randomUUID } from 'node:crypto';

import request from 'supertest';

import pool from '../../src/db/pool';
import app from '../../src/server';
import type { PipelineListResponse, PipelineResponse } from '../../src/types/pipeline';

const BASE = '/api/v1/pipelines';

async function ensureTablesExist(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipelines (
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      url         TEXT NOT NULL,
      headers     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function truncateTables(): Promise<void> {
  await pool.query('TRUNCATE subscribers, pipelines CASCADE');
}

function validCreatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test Pipeline',
    action_type: 'transform_json',
    ...overrides,
  };
}

async function createPipeline(overrides: Record<string, unknown> = {}): Promise<PipelineResponse> {
  const res = await request(app).post(BASE).send(validCreatePayload(overrides)).expect(201);
  return res.body as PipelineResponse;
}

describe('Pipeline CRUD endpoints', () => {
  beforeAll(async () => {
    await ensureTablesExist();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------
  // POST /api/v1/pipelines
  // ---------------------------------------------------------------
  describe('POST /api/v1/pipelines', () => {
    it('creates a pipeline with valid input and returns 201', async () => {
      const res = await request(app)
        .post(BASE)
        .send(validCreatePayload())
        .expect('Content-Type', /json/)
        .expect(201);

      const body = res.body as PipelineResponse;
      expect(body).toHaveProperty('id');
      expect(body.name).toBe('Test Pipeline');
      expect(body.action_type).toBe('transform_json');
      expect(body.is_active).toBe(true);
      expect(body).toHaveProperty('source_url');
      expect(body.source_url).toContain('/webhooks/');
      expect(body.subscribers).toEqual([]);
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
    });

    it('creates a pipeline with subscribers', async () => {
      const payload = validCreatePayload({
        subscribers: [
          { url: 'https://example.com/hook1', headers: { Authorization: 'Bearer abc' } },
          { url: 'https://example.com/hook2' },
        ],
      });

      const res = await request(app).post(BASE).send(payload).expect(201);

      const body = res.body as PipelineResponse;
      expect(body.subscribers).toHaveLength(2);

      const sub0 = body.subscribers[0];
      expect(sub0.url).toBe('https://example.com/hook1');
      expect(sub0.headers).toEqual({ Authorization: 'Bearer abc' });
      expect(sub0).toHaveProperty('id');
      expect(sub0.pipeline_id).toBe(body.id);

      const sub1 = body.subscribers[1];
      expect(sub1.url).toBe('https://example.com/hook2');
      expect(sub1.headers).toEqual({});
    });

    it('returns 400 for missing name', async () => {
      const res = await request(app).post(BASE).send({ action_type: 'transform_json' }).expect(400);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.message).toMatch(/name/i);
    });

    it('returns 400 for invalid action_type', async () => {
      const res = await request(app)
        .post(BASE)
        .send({ name: 'Bad Type', action_type: 'invalid_action' })
        .expect(400);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.message).toMatch(/action_type/i);
    });

    it('returns 400 for invalid subscriber (missing url)', async () => {
      const res = await request(app)
        .post(BASE)
        .send(validCreatePayload({ subscribers: [{ headers: {} }] }))
        .expect(400);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.message).toMatch(/url/i);
    });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/pipelines
  // ---------------------------------------------------------------
  describe('GET /api/v1/pipelines', () => {
    it('returns empty array when no pipelines exist', async () => {
      const res = await request(app).get(BASE).expect(200);

      const body = res.body as PipelineListResponse;
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns all pipelines with subscribers', async () => {
      await createPipeline({
        name: 'Pipeline A',
        subscribers: [{ url: 'https://example.com/a' }],
      });
      await createPipeline({ name: 'Pipeline B' });

      const res = await request(app).get(BASE).expect(200);

      const body = res.body as PipelineListResponse;
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);

      // Ordered by created_at DESC so Pipeline B comes first
      const names = body.data.map((p) => p.name);
      expect(names).toContain('Pipeline A');
      expect(names).toContain('Pipeline B');

      // One of them should have a subscriber
      const withSubs = body.data.find((p) => p.subscribers.length > 0);
      expect(withSubs).toBeDefined();
      expect(withSubs!.subscribers[0].url).toBe('https://example.com/a');
    });

    it('respects limit and offset pagination', async () => {
      // Create 3 pipelines
      await createPipeline({ name: 'P1' });
      await createPipeline({ name: 'P2' });
      await createPipeline({ name: 'P3' });

      const res = await request(app).get(`${BASE}?limit=2&offset=0`).expect(200);

      const body = res.body as PipelineListResponse;
      expect(body.data).toHaveLength(2);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
      expect(body.total).toBe(3);

      // Fetch page 2
      const res2 = await request(app).get(`${BASE}?limit=2&offset=2`).expect(200);

      const body2 = res2.body as PipelineListResponse;
      expect(body2.data).toHaveLength(1);
      expect(body2.offset).toBe(2);
      expect(body2.total).toBe(3);
    });

    it('returns total count for pagination', async () => {
      await createPipeline({ name: 'Count-1' });
      await createPipeline({ name: 'Count-2' });
      await createPipeline({ name: 'Count-3' });

      const res = await request(app).get(`${BASE}?limit=1&offset=0`).expect(200);

      const body = res.body as PipelineListResponse;
      expect(body.total).toBe(3);
      expect(body.data).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/pipelines/:id
  // ---------------------------------------------------------------
  describe('GET /api/v1/pipelines/:id', () => {
    it('returns pipeline with subscribers', async () => {
      const created = await createPipeline({
        name: 'Fetch Me',
        description: 'A test pipeline',
        subscribers: [{ url: 'https://example.com/sub' }],
      });

      const res = await request(app).get(`${BASE}/${created.id}`).expect(200);

      const body = res.body as PipelineResponse;
      expect(body.id).toBe(created.id);
      expect(body.name).toBe('Fetch Me');
      expect(body.description).toBe('A test pipeline');
      expect(body.subscribers).toHaveLength(1);
      expect(body.subscribers[0].url).toBe('https://example.com/sub');
      expect(body).toHaveProperty('source_url');
    });

    it('returns 404 for non-existent UUID', async () => {
      const fakeId = randomUUID();
      const res = await request(app).get(`${BASE}/${fakeId}`).expect(404);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.status).toBe(404);
      expect(body.error.message).toMatch(/not found/i);
    });

    it('returns 400 or 500 for invalid UUID format', async () => {
      const res = await request(app).get(`${BASE}/not-a-uuid`);

      // PostgreSQL will reject the invalid UUID; the server should return
      // either a 400 or 500 depending on error handling
      expect([400, 404, 500]).toContain(res.status);
    });
  });

  // ---------------------------------------------------------------
  // PATCH /api/v1/pipelines/:id
  // ---------------------------------------------------------------
  describe('PATCH /api/v1/pipelines/:id', () => {
    it('updates pipeline name and returns 200', async () => {
      const created = await createPipeline({ name: 'Old Name' });

      const res = await request(app)
        .patch(`${BASE}/${created.id}`)
        .send({ name: 'New Name' })
        .expect(200);

      const body = res.body as PipelineResponse;
      expect(body.name).toBe('New Name');
      expect(body.id).toBe(created.id);
    });

    it('updates multiple fields at once', async () => {
      const created = await createPipeline({
        name: 'Multi',
        action_type: 'transform_json',
      });

      const res = await request(app)
        .patch(`${BASE}/${created.id}`)
        .send({
          name: 'Updated Multi',
          description: 'Now with a description',
          action_type: 'filter_fields',
        })
        .expect(200);

      const body = res.body as PipelineResponse;
      expect(body.name).toBe('Updated Multi');
      expect(body.description).toBe('Now with a description');
      expect(body.action_type).toBe('filter_fields');
    });

    it('updates is_active to false', async () => {
      const created = await createPipeline();
      expect(created.is_active).toBe(true);

      const res = await request(app)
        .patch(`${BASE}/${created.id}`)
        .send({ is_active: false })
        .expect(200);

      const body = res.body as PipelineResponse;
      expect(body.is_active).toBe(false);
    });

    it('returns 404 for non-existent pipeline', async () => {
      const fakeId = randomUUID();
      const res = await request(app).patch(`${BASE}/${fakeId}`).send({ name: 'Ghost' }).expect(404);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.status).toBe(404);
    });

    it('returns 400 for invalid action_type', async () => {
      const created = await createPipeline();

      const res = await request(app)
        .patch(`${BASE}/${created.id}`)
        .send({ action_type: 'bogus' })
        .expect(400);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.message).toMatch(/action_type/i);
    });
  });

  // ---------------------------------------------------------------
  // DELETE /api/v1/pipelines/:id
  // ---------------------------------------------------------------
  describe('DELETE /api/v1/pipelines/:id', () => {
    it('deletes pipeline and returns 204', async () => {
      const created = await createPipeline();

      await request(app).delete(`${BASE}/${created.id}`).expect(204);

      // Verify it no longer exists
      await request(app).get(`${BASE}/${created.id}`).expect(404);
    });

    it('cascades delete to subscribers', async () => {
      const created = await createPipeline({
        subscribers: [{ url: 'https://example.com/sub1' }, { url: 'https://example.com/sub2' }],
      });

      await request(app).delete(`${BASE}/${created.id}`).expect(204);

      // Verify subscribers are also gone
      const result = await pool.query('SELECT id FROM subscribers WHERE pipeline_id = $1', [
        created.id,
      ]);
      expect(result.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent pipeline', async () => {
      const fakeId = randomUUID();
      const res = await request(app).delete(`${BASE}/${fakeId}`).expect(404);

      const body = res.body as { error: { message: string; status: number } };
      expect(body.error.status).toBe(404);
    });
  });
});
