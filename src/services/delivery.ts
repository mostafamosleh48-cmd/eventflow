import pool from '../db/pool';
import type { Subscriber } from '../types/pipeline';

export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_BACKOFF_SCHEDULE_SECONDS = [30, 120, 600, 1800, 7200] as const;

export interface DeliveryAttemptResult {
  success: boolean;
  statusCode: number | null;
  responseBody: string;
  attemptNumber: number;
}

export function calculateDeliveryRetryDelaySeconds(retryNumber: number): number | null {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) {
    return null;
  }

  const delay = DELIVERY_BACKOFF_SCHEDULE_SECONDS[retryNumber - 1];
  return delay ?? null;
}

async function recordDeliveryAttempt(
  jobId: string,
  subscriberId: string,
  statusCode: number | null,
  success: boolean,
  responseBody: string,
  attemptNumber: number
): Promise<void> {
  await pool.query(
    `INSERT INTO delivery_attempts (job_id, subscriber_id, status_code, success, response_body, attempt_number)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jobId, subscriberId, statusCode, success, responseBody, attemptNumber]
  );
}

export async function deliverToSubscriber(
  jobId: string,
  subscriber: Subscriber,
  payload: Record<string, unknown>,
  attemptNumber: number
): Promise<DeliveryAttemptResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  let statusCode: number | null = null;
  let success = false;
  let responseBody: string;

  try {
    const response = await fetch(subscriber.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...subscriber.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    statusCode = response.status;
    responseBody = await response.text();
    success = response.status >= 200 && response.status < 300;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      responseBody = `Request timed out after ${DELIVERY_TIMEOUT_MS}ms`;
    } else if (error instanceof Error) {
      responseBody = error.message;
    } else {
      responseBody = 'Unknown delivery error';
    }
  } finally {
    clearTimeout(timeout);
  }

  await recordDeliveryAttempt(
    jobId,
    subscriber.id,
    statusCode,
    success,
    responseBody,
    attemptNumber
  );

  return {
    success,
    statusCode,
    responseBody,
    attemptNumber,
  };
}
