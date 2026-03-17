import 'dotenv/config';

import type { Job as PgBossJob } from 'pg-boss';

import { runAction } from './actions/index';
import type { PipelineContext } from './actions/index';
import pool from './db/pool';
import {
  deliverToSubscriber,
  calculateDeliveryRetryDelaySeconds,
  MAX_DELIVERY_ATTEMPTS,
} from './services/delivery';
import {
  enqueueDeliveryRetry,
  getQueueName,
  startQueue,
  stopQueue,
  type DeliveryRetryJobData,
  type QueueJobData,
  type WebhookJobData,
} from './services/queue';
import type { Pipeline, Subscriber } from './types/pipeline';

function isDeliveryRetryJobData(jobData: QueueJobData): jobData is DeliveryRetryJobData {
  return 'type' in jobData && jobData.type === 'delivery_retry';
}

async function scheduleDeliveryRetry(
  jobId: string,
  pipelineId: string,
  subscriberId: string,
  payload: Record<string, unknown>,
  attemptNumber: number
): Promise<void> {
  if (attemptNumber >= MAX_DELIVERY_ATTEMPTS) {
    return;
  }

  const retryNumber = attemptNumber;
  const delaySeconds = calculateDeliveryRetryDelaySeconds(retryNumber);
  if (delaySeconds === null) {
    return;
  }

  await enqueueDeliveryRetry(
    jobId,
    pipelineId,
    subscriberId,
    payload,
    attemptNumber + 1,
    delaySeconds
  );
}

async function fetchPipeline(pipelineId: string): Promise<Pipeline | null> {
  const pipelineResult = await pool.query<Pipeline>('SELECT * FROM pipelines WHERE id = $1', [
    pipelineId,
  ]);
  return pipelineResult.rows[0] ?? null;
}

async function fetchSubscribers(pipelineId: string): Promise<Subscriber[]> {
  const subscribersResult = await pool.query<Subscriber>(
    'SELECT id, pipeline_id, url, headers, created_at FROM subscribers WHERE pipeline_id = $1',
    [pipelineId]
  );

  return subscribersResult.rows;
}

async function processWebhookJob(data: WebhookJobData): Promise<void> {
  const { jobId, pipelineId, payload } = data;

  try {
    await pool.query(
      'UPDATE jobs SET status = $1, attempts = attempts + 1, updated_at = NOW() WHERE id = $2',
      ['processing', jobId]
    );

    const pipeline = await fetchPipeline(pipelineId);

    if (!pipeline) {
      await pool.query(
        'UPDATE jobs SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3',
        ['failed', `Pipeline with id '${pipelineId}' not found`, jobId]
      );
      return;
    }

    const context: PipelineContext = {
      pipeline_id: pipeline.id,
      pipeline_name: pipeline.name,
      action_type: pipeline.action_type,
    };

    const result = runAction(pipeline.action_type, payload, pipeline.action_config, context);
    const subscribers = await fetchSubscribers(pipeline.id);

    for (const subscriber of subscribers) {
      const deliveryResult = await deliverToSubscriber(jobId, subscriber, result, 1);

      if (!deliveryResult.success) {
        await scheduleDeliveryRetry(jobId, pipeline.id, subscriber.id, result, 1);
      }
    }

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

async function processDeliveryRetryJob(data: DeliveryRetryJobData): Promise<void> {
  const { jobId, pipelineId, subscriberId, payload, attemptNumber } = data;

  const subscriberResult = await pool.query<Subscriber>(
    `SELECT id, pipeline_id, url, headers, created_at
     FROM subscribers
     WHERE id = $1 AND pipeline_id = $2`,
    [subscriberId, pipelineId]
  );

  const subscriber = subscriberResult.rows[0];
  if (!subscriber) {
    return;
  }

  const deliveryResult = await deliverToSubscriber(jobId, subscriber, payload, attemptNumber);

  if (!deliveryResult.success) {
    await scheduleDeliveryRetry(jobId, pipelineId, subscriber.id, payload, attemptNumber);
  }
}

export async function processQueueJob(data: QueueJobData): Promise<void> {
  if (isDeliveryRetryJobData(data)) {
    await processDeliveryRetryJob(data);
    return;
  }

  await processWebhookJob(data);
}

export async function startWorker(): Promise<void> {
  const boss = await startQueue();

  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10);
  const queueName = getQueueName();

  await boss.work<QueueJobData>(
    queueName,
    { batchSize: 1, localConcurrency: concurrency },
    async (jobs: PgBossJob<QueueJobData>[]): Promise<void> => {
      for (const job of jobs) {
        await processQueueJob(job.data);
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

if (require.main === module) {
  startWorker().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
}
