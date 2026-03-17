import { PgBoss } from 'pg-boss';

const QUEUE_NAME = 'webhook-jobs';

export interface WebhookJobData {
  jobId: string;
  pipelineId: string;
  payload: Record<string, unknown>;
}

export interface DeliveryRetryJobData {
  type: 'delivery_retry';
  jobId: string;
  pipelineId: string;
  subscriberId: string;
  payload: Record<string, unknown>;
  attemptNumber: number;
}

export type QueueJobData = WebhookJobData | DeliveryRetryJobData;

let boss: PgBoss | null = null;

export async function startQueue(): Promise<PgBoss> {
  if (boss) {
    return boss;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  boss = new PgBoss({ connectionString });

  boss.on('error', (error: Error) => {
    // eslint-disable-next-line no-console
    console.error('pg-boss error:', error);
  });

  await boss.start();
  await boss.createQueue(QUEUE_NAME);
  // eslint-disable-next-line no-console
  console.log('pg-boss queue started');

  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    // eslint-disable-next-line no-console
    console.log('pg-boss queue stopped');
  }
}

export async function enqueueJob(
  jobId: string,
  pipelineId: string,
  payload: Record<string, unknown>
): Promise<string | null> {
  if (!boss) {
    throw new Error('Queue not started. Call startQueue() first.');
  }

  const pgBossJobId = await boss.send(QUEUE_NAME, {
    jobId,
    pipelineId,
    payload,
  } as WebhookJobData);

  return pgBossJobId;
}

export async function enqueueDeliveryRetry(
  jobId: string,
  pipelineId: string,
  subscriberId: string,
  payload: Record<string, unknown>,
  attemptNumber: number,
  delaySeconds: number
): Promise<string | null> {
  if (!boss) {
    throw new Error('Queue not started. Call startQueue() first.');
  }

  const retryJobData: DeliveryRetryJobData = {
    type: 'delivery_retry',
    jobId,
    pipelineId,
    subscriberId,
    payload,
    attemptNumber,
  };

  const pgBossJobId = await boss.sendAfter(QUEUE_NAME, retryJobData, null, delaySeconds);

  return pgBossJobId;
}

export function getQueueName(): string {
  return QUEUE_NAME;
}

export function getQueueInstance(): PgBoss | null {
  return boss;
}
