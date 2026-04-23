import { Pool } from 'pg';
import { pool as sharedPool } from '../../database/postgres/pool';
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
   * Utilizes a collision-free strategy by generating the ID from a sequence first.
   */
  async shortenUrl(originalUrl: string, ownerId?: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Fetch the next ID from the sequence to guarantee uniqueness without placeholders
      const seqRes = await client.query("SELECT nextval('urls_id_seq') as id");
      const id = BigInt(seqRes.rows[0].id);

      // 2. Generate actual alias from the reserved ID
      const alias = generateAlias(id);

      // 3. Perform a single INSERT with the final ID and Alias
      const insertQuery = `
        INSERT INTO urls (id, alias, original_url, owner_id)
        VALUES ($1, $2, $3, $4)
        RETURNING alias;
      `;
      
      await client.query(insertQuery, [id.toString(), alias, originalUrl, ownerId]);

      await client.query('COMMIT');

      // Warm cache
      // Warm cache with the full record for consistency with resolveUrl
      const record: UrlRecord = {
        id,
        alias,
        original_url: originalUrl,
        owner_id: ownerId,
        created_at: new Date() // Approximate for cache warming
      };
      await redis.set(`url:${alias}`, JSON.stringify(record, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      ), this.CACHE_TTL);
      
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
   * Resolves an alias to the original URL record using a read-through cache strategy.
   * Returns the mapped UrlRecord or null if not found.
   */
  async resolveUrl(alias: string): Promise<UrlRecord | null> {
    try {
      // 1. Try Redis cache
      const cachedData = await redis.get(`url:${alias}`);
      if (cachedData) {
        try {
          const parsed = JSON.parse(cachedData);
          return {
            ...parsed,
            id: BigInt(parsed.id),
            created_at: new Date(parsed.created_at)
          } as UrlRecord;
        } catch (e) {
          // If cache is poisoned with a raw string, treat as miss and refresh
          logger.warn({ alias }, 'Cache data corrupted, falling back to DB');
        }
      }
    } catch (error) {
      // Fail-open: If Redis is down, log the error but proceed to DB query
      logger.error({ error, alias }, 'Redis lookup failed, falling back to database');
    }

    try {
      // 2. Cache miss or Redis failure, query PostgreSQL
      const query = 'SELECT id, alias, original_url, owner_id, created_at FROM urls WHERE alias = $1 LIMIT 1';
      const result = await this.pool.query(query, [alias]);

      if (result.rows.length === 0) {
        return null;
      }

      const record: UrlRecord = {
        id: BigInt(result.rows[0].id),
        alias: result.rows[0].alias,
        original_url: result.rows[0].original_url,
        owner_id: result.rows[0].owner_id,
        created_at: result.rows[0].created_at,
      };

      // 3. Populate Redis (non-blocking, don't throw if this fails)
      try {
        await redis.set(`url:${alias}`, JSON.stringify(record, (key, value) => 
          typeof value === 'bigint' ? value.toString() : value
        ), this.CACHE_TTL);
      } catch (redisErr) {
        logger.warn({ redisErr }, 'Failed to update Redis cache');
      }

      return record;
    } catch (error) {
      logger.error({ error, alias }, 'Error during URL resolution');
      throw new Error('Internal server error during resolution');
    }
  }

}

export const urlService = new UrlService(sharedPool);

