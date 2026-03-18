import dotenv from 'dotenv';

dotenv.config();

import express from 'express';

import { jobsRouter } from './routes/jobs';
import { pipelineRouter } from './routes/pipelines';
import { webhookRouter } from './routes/webhooks';
import { startQueue, stopQueue } from './services/queue';
import { errorHandler } from './utils/errorHandler';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1/jobs', jobsRouter);
app.use('/api/v1/pipelines', pipelineRouter);
app.use('/webhooks', webhookRouter);

app.use(errorHandler);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API server listening on port ${PORT}`);

  startQueue().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start pg-boss queue:', err);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    stopQueue()
      .then(() => {
        // eslint-disable-next-line no-console
        console.log('Server and queue shut down.');
        process.exit(0);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('Error during shutdown:', err);
        process.exit(1);
      });
  });
});

export default app;
