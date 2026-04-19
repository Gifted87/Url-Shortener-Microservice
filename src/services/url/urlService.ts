import { Pool } from 'pg';
import { redis } from '../../database/redis/redisClient';
import { generateAlias } from '../../utils/hashing/aliasGenerator';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Interface representing the URL mapping record in the database.
 */
export interface UrlRecord {
  id: bigint;
  alias: string;
  original_url: string;
  created_at: Date;
  owner_id?: string;
}

/**
 * URL Service for managing high-performance URL shortening and resolution.
 * Implemented as a singleton.
 */
class UrlService {
  private pool: Pool;
  private readonly CACHE_TTL = 86400; // 24 hours in seconds

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Shortens a long URL by persisting to PostgreSQL and caching in Redis.
   */
  async shortenUrl(originalUrl: string, ownerId?: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert record and get the BIGSERIAL ID
      const insertQuery = `
        INSERT INTO urls (alias, original_url, owner_id)
        VALUES ($1, $2, $3)
        RETURNING id, alias;
      `;
      
      // Temporary alias to allow ID generation; alias updated post-insertion
      const tempAlias = 'temp'; 
      const res = await client.query(insertQuery, [tempAlias, originalUrl, ownerId]);
      const id = BigInt(res.rows[0].id);
      
      // Generate actual alias from ID
      const alias = generateAlias(id);
      
      // Update with generated alias
      await client.query('UPDATE urls SET alias = $1 WHERE id = $2', [alias, id]);

      await client.query('COMMIT');

      // Warm cache
      await redis.set(`url:${alias}`, originalUrl, this.CACHE_TTL);
      
      logger.info({ alias, originalUrl }, 'URL shortened successfully');
      return alias;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, originalUrl }, 'Failed to shorten URL');
      throw new Error('Internal server error during URL creation');
    } finally {
      client.release();
    }
  }

  /**
   * Resolves an alias to the original URL using a read-through cache strategy.
   */
  async resolveUrl(alias: string): Promise<string | null> {
    try {
      // 1. Try Redis cache
      const cachedUrl = await redis.get(`url:${alias}`);
      if (cachedUrl) {
        return cachedUrl;
      }

      // 2. Cache miss, query PostgreSQL
      const query = 'SELECT original_url FROM urls WHERE alias = $1 LIMIT 1';
      const result = await this.pool.query(query, [alias]);

      if (result.rows.length === 0) {
        return null;
      }

      const originalUrl = result.rows[0].original_url;

      // 3. Populate Redis
      await redis.set(`url:${alias}`, originalUrl, this.CACHE_TTL);

      return originalUrl;
    } catch (error) {
      logger.error({ error, alias }, 'Error during URL resolution');
      throw new Error('Internal server error during resolution');
    }
  }
}

// In a real production app, the pool would be injected from a shared connection module
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const urlService = new UrlService(pool);
