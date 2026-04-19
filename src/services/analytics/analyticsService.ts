import { redis } from '../../database/redis/redisClient';
import { Pool } from 'pg';
import pino from 'pino';
import { isIP } from 'net';

const logger = pino({ level: 'info' });

/**
 * Interface for click metadata passed to the analytics service.
 */
export interface ClickEvent {
    url_id: number;
    ip_address: string;
    user_agent: string;
    referer: string;
}

/**
 * AnalyticsService provides non-blocking event ingestion and buffered persistence.
 */
class AnalyticsService {
    private readonly BUFFER_KEY = 'analytics:buffer';
    private readonly MAX_BUFFER_SIZE = 10000;
    private readonly pgPool: Pool;

    constructor() {
        this.pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 20,
            idleTimeoutMillis: 30000,
        });
    }

    /**
     * Sanitizes headers to prevent XSS and log-injection.
     */
    private sanitize(value: string | undefined): string {
        if (!value) return '';
        return value.replace(/[<>]/g, '').trim().substring(0, 512);
    }

    /**
     * Captures request metadata and offloads to Redis for real-time aggregation and batching.
     */
    async trackClick(urlId: number, ip: string, userAgent: string, referer: string): Promise<void> {
        if (!isIP(ip)) {
            logger.warn({ ip }, 'Invalid IP address received');
            return;
        }

        const sanitizedUA = this.sanitize(userAgent);
        const sanitizedReferer = this.sanitize(referer);
        const timestamp = new Date().toISOString();

        try {
            // Check buffer backpressure
            const bufferSize = await redis.llen(this.BUFFER_KEY);
            if (bufferSize >= this.MAX_BUFFER_SIZE) {
                logger.error('Analytics buffer limit exceeded. Dropping events.');
                return;
            }

            // Real-time metric aggregation: Click Count
            await redis.hincrby(`metrics:clicks:${urlId}`, 'total', 1);

            // Real-time metric aggregation: Unique Visitor Fingerprint
            const fingerprint = `${ip}:${sanitizedUA}`;
            await redis.sadd(`metrics:visitors:${urlId}:${new Date().toISOString().slice(0, 10)}`, fingerprint);

            // Buffered Persistence
            const eventPayload = JSON.stringify({
                url_id: urlId,
                timestamp,
                ip_address: ip,
                user_agent: sanitizedUA,
                referer: sanitizedReferer
            });

            await redis.rpush(this.BUFFER_KEY, eventPayload);
        } catch (err) {
            logger.error({ err }, 'Failed to buffer click event');
        }
    }

    /**
     * Processes buffered clicks and flushes to PostgreSQL.
     * Intended to be called by a background worker process.
     */
    async processBufferedClicks(batchSize: number = 100): Promise<void> {
        const client = await this.pgPool.connect();
        try {
            for (let i = 0; i < batchSize; i++) {
                const rawEvent = await redis.lpop(this.BUFFER_KEY);
                if (!rawEvent) break;

                const event = JSON.parse(rawEvent) as ClickEvent & { timestamp: string };

                try {
                    await client.query(
                        `INSERT INTO clicks (url_id, timestamp, ip_address, user_agent, referer) 
                         VALUES ($1, $2, $3, $4, $5)`,
                        [event.url_id, event.timestamp, event.ip_address, event.user_agent, event.referer]
                    );
                } catch (dbErr) {
                    logger.error({ dbErr, event }, 'Database flush failed, re-queueing');
                    await redis.rpush(this.BUFFER_KEY, rawEvent);
                    throw dbErr;
                }
            }
        } catch (err) {
            logger.error({ err }, 'Error during background processing cycle');
        } finally {
            client.release();
        }
    }
}

export const analyticsService = new AnalyticsService();
