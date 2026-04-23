import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Shared PostgreSQL connection pool for the entire microservice.
 * This ensures efficient resource utilization and prevents connection exhaustion.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Resiliency check: only attach event listener if the object supports it (avoids crashes with simple mocks)
if (typeof pool.on === 'function') {
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected error on idle database client');
  });

  pool.on('connect', () => {
    logger.debug('New database client connected to pool');
  });
}
