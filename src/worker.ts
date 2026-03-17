import 'dotenv/config';

import type { Job as PgBossJob } from 'pg-boss';

import { startQueue, stopQueue, getQueueName } from './services/queue';
import pool from './db/pool';
import { runAction } from './actions/index';
import type { PipelineContext } from './actions/index';
import type { Pipeline } from './types/pipeline';

interface WebhookJobData {
  jobId: string;
  pipelineId: string;
  payload: Record<string, unknown>;
}

async function processJob(data: WebhookJobData): Promise<void> {
  const { jobId, pipelineId, payload } = data;

  try {
    // Mark job as processing
    await pool.query(
      'UPDATE jobs SET status = $1, attempts = attempts + 1, updated_at = NOW() WHERE id = $2',
      ['processing', jobId]
    );

    // Fetch the pipeline
    const pipelineResult = await pool.query<Pipeline>('SELECT * FROM pipelines WHERE id = $1', [
      pipelineId,
    ]);

    const pipeline = pipelineResult.rows[0];

    if (!pipeline) {
      await pool.query(
        'UPDATE jobs SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3',
        ['failed', `Pipeline with id '${pipelineId}' not found`, jobId]
      );
      return;
    }

    // Build pipeline context
    const context: PipelineContext = {
      pipeline_id: pipeline.id,
      pipeline_name: pipeline.name,
      action_type: pipeline.action_type,
    };

    // Run the action
    const result = runAction(pipeline.action_type, payload, pipeline.action_config, context);

    // Mark job as completed
    await pool.query(
      'UPDATE jobs SET status = $1, result = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $3',
      ['completed', JSON.stringify(result), jobId]
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    // eslint-disable-next-line no-console
    console.error(`Job ${jobId} failed:`, errorMessage);

    await pool.query(
      'UPDATE jobs SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3',
      ['failed', errorMessage, jobId]
    );
  }
}

async function main(): Promise<void> {
  const boss = await startQueue();

  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10);
  const queueName = getQueueName();

  await boss.work<WebhookJobData>(
    queueName,
    { batchSize: 1, localConcurrency: concurrency },
    async (jobs: PgBossJob<WebhookJobData>[]): Promise<void> => {
      for (const job of jobs) {
        await processJob(job.data);
      }
    }
  );

  // eslint-disable-next-line no-console
  console.log(`Worker listening on queue "${queueName}" with concurrency ${concurrency}`);
}

process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('Worker shutting down...');
  stopQueue()
    .then(() => pool.end())
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Error during shutdown:', err);
      process.exit(1);
    });
});

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', err);
  process.exit(1);
});
