import fs from 'node:fs';
import { createApp, finalizeApp, registerRouters } from './app';
import { env } from './env';
import { logger } from './lib/logger';
import { prisma } from './db';
import { apiRouters } from './routes';

fs.mkdirSync(env.uploadsDir, { recursive: true });

const app = createApp();
registerRouters(app, apiRouters);
finalizeApp(app);

const server = app.listen(env.port, () => {
  logger.info('api.started', { port: env.port, env: env.nodeEnv });
});

async function shutdown(signal: string) {
  logger.info('api.shutdown', { signal });
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});
