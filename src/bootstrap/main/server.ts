import express, { Express } from 'express';
import http from 'http';
import pino from 'pino';
import { config } from '../../config/env';
import { helmetMiddleware, requestSanitizationMiddleware } from '../../middleware/security/securityMiddleware';
import { rateLimiter } from '../../middleware/rate_limiter';
import v1Router from '../../routes/shortener';
import { HealthController } from '../health/health';
import { ShutdownManager } from '../lifecycle/shutdown';
import { pool } from '../../database/postgres/pool';
import { redis } from '../../database/redis/redisClient';

/**
 * @file server.ts
 * @description Centralized server bootstrap entry point for the URL shortener microservice.
 * Orchestrates environment validation, security middleware injection, and HTTP server lifecycle.
 */

const logger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Bootstraps the Express application instance with security primitives.
 * @returns {Express} The configured Express application.
 */
export function createServer(): Express {
  const app = express();
  
  // 0. Networking Infrastructure
  app.set('trust proxy', config.PROXY_TRUST_DEPTH);

  try {
    // 1. Security Infrastructure
    app.use(helmetMiddleware);
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    
    // 2. Request Sanitization
    app.use(requestSanitizationMiddleware);
    
    // 3. Distributed Rate Limiting
    app.use(rateLimiter);

    // Mount API Routes
    app.use('/api', v1Router);
    
    // 4. Infrastructure Health Probes
    app.use(HealthController.createRouter(pool, redis));

  } catch (error) {
    logger.fatal({ error }, 'Failed to initialize Express application components');
    process.exit(1);
  }

  return app;
}

/**
 * Initializes and starts the HTTP server.
 * Implements graceful binding and structured lifecycle logging.
 */
export async function startServer() {
  const app = createServer();
  const server = http.createServer(app);

  const port = config.PORT;

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => {
        logger.info({ port }, 'Service initialized and listening on port');
        resolve();
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.fatal({ port, error: err }, 'Port is already in use');
          reject(err);
        } else {
          logger.fatal({ error: err }, 'Unexpected server error');
          reject(err);
        }
      });
    });
  } catch (error) {
    process.exit(1);
  }

  // Graceful Shutdown Logic
  const shutdownManager = new ShutdownManager(server, pool);
  shutdownManager.initialize();

  // Listen for IPC messages from Cluster Manager (K8s friendly shutdown)
  process.on('message', (msg) => {
    if (msg && typeof msg === 'object' && (msg as any).type === 'SHUTDOWN') {
      logger.info('IPC Shutdown signal received from cluster manager');
      // shutdownManager handles signals, but we can trigger it manually for IPC
      process.emit('SIGTERM');
    }
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.fatal({ error: err }, 'Server bootstrap failed');
    process.exit(1);
  });
}

