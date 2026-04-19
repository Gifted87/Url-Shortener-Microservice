import express, { Express } from 'express';
import http from 'http';
import pino from 'pino';
import { config } from '../../config/env';
import { helmetMiddleware, requestSanitizationMiddleware } from '../../middleware/security/securityMiddleware';
import { rateLimiter } from '../../middleware/rate_limiter';

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

  try {
    // 1. Security Infrastructure
    app.use(helmetMiddleware);
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    
    // 2. Request Sanitization
    app.use(requestSanitizationMiddleware);
    
    // 3. Distributed Rate Limiting
    app.use(rateLimiter);

    // Placeholder for router integration
    // app.use('/api', v1Router);
    
    app.get('/health', (req, res) => {
      res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
    });

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
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received. Initiating graceful shutdown.');
    server.close(() => {
      logger.info('HTTP server closed. Exiting process.');
      process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
      logger.error('Graceful shutdown timeout exceeded. Forcing exit.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.fatal({ error: err }, 'Server bootstrap failed');
    process.exit(1);
  });
}
