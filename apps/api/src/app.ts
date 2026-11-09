import cors from 'cors';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './env';
import { errorEnvelope } from './lib/http';
import { logger } from './lib/logger';
import { attachActor } from './middleware/auth';
import {
  csrfGuard,
  globalLimiter,
  requestId,
  sameOriginGuard,
  securityHeaders,
} from './middleware/security';
import { authRouter } from './modules/auth';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: false, // API returns JSON only; the web app sets its own CSP
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
      exposedHeaders: ['x-request-id'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(securityHeaders);
  app.use(sameOriginGuard);
  app.use(globalLimiter);

  app.get('/api/v1/health', async (_req, res) => {
    const started = Date.now();
    let db = 'ok';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { prisma } = require('./db') as typeof import('./db');
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'unavailable';
    }
    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded',
      version: 'v1',
      db,
      uptimeSeconds: Math.round(process.uptime()),
      latencyMs: Date.now() - started,
    });
  });

  // Resolve the session for every API call first, then enforce CSRF, then mount
  // routers. Order matters: mounting auth before attachActor would leave
  // /auth/me without a principal.
  app.use(attachActor);
  app.use('/api/v1', csrfGuard);
  app.use('/api/v1/auth', authRouter);

  return app;
}

export function registerRouters(app: express.Express, routers: express.Router[]) {
  for (const router of routers) app.use('/api/v1', router);
}

/**
 * Adds the not-found and error handlers. Must run after routers are mounted,
 * otherwise genuine API routes would be shadowed by the 404.
 */
export function finalizeApp(app: express.Express) {
  app.use('/api/v1', (req, res) => {
    if (res.headersSent) return;
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });
  });

  // Central error handler: structured, never leaks stack traces in production.
  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, body } = errorEnvelope(error);
    if (status >= 500) {
      logger.error('request.failed', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        error: (error as Error)?.message,
      });
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  });

  return app;
}
