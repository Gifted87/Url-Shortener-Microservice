import { redis } from '../../database/redis/redisClient';
import { Pool } from 'pg';
import { pool as sharedPool } from '../../database/postgres/pool';
import pino from 'pino';
import { isIP } from 'net';

const logger = pino({ level: 'info' });

/**
 * Interface for click metadata passed to the analytics service.
 */
export interface ClickEvent {
    url_id: string;
    ip_address: string;
    user_agent: string;
    referer: string;
}

/**
 * AnalyticsService provides non-blocking event ingestion and buffered persistence.
 */
export class AnalyticsService {
    private readonly BUFFER_KEY = 'analytics:buffer';
    private readonly MAX_BUFFER_SIZE = 10000;
    private readonly pgPool: Pool;

    constructor(pool: Pool) {
        this.pgPool = pool;
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
    async trackClick(urlId: string, ip: string, userAgent: string, referer: string): Promise<void> {
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
    /**
     * Processes buffered clicks and flushes to PostgreSQL using high-throughput bulk insertion.
     */
    async processBufferedClicks(batchSize: number = 100): Promise<void> {
        const rawEvents: string[] = [];
        const parsedEvents: (ClickEvent & { timestamp: string })[] = [];

        for (let i = 0; i < batchSize; i++) {
            const raw = await redis.lpop(this.BUFFER_KEY);
            if (typeof raw !== 'string' || raw.length === 0) break;
            
            try {
                const parsed = JSON.parse(raw) as ClickEvent & { timestamp: string };
                rawEvents.push(raw);
                parsedEvents.push(parsed);
            } catch (e) {
                logger.error({ e, raw }, 'Discarding unparseable analytics event');
            }
        }

        if (parsedEvents.length === 0) return;

        const client = await this.pgPool.connect();
        try {
            const paramCount = 5;
            const placeholders = parsedEvents.map((_, i) => 
                `($${i * paramCount + 1}, $${i * paramCount + 2}, $${i * paramCount + 3}, $${i * paramCount + 4}, $${i * paramCount + 5})`
            ).join(',');

            const flatParams = parsedEvents.flatMap(e => [
                e.url_id,
                e.timestamp,
                e.ip_address,
                this.sanitize(e.user_agent),
                this.sanitize(e.referer)
            ]);

            const query = `INSERT INTO clicks (url_id, timestamp, ip_address, user_agent, referer) VALUES ${placeholders}`;
            await client.query(query, flatParams);
        } catch (err) {
            logger.error({ err }, 'Bulk insert failed. Re-queueing batch.');
            for (const raw of rawEvents) {
                await redis.rpush(this.BUFFER_KEY, raw);
            }
            throw err;
        } finally {
            client.release();
        }
    }
}

export const analyticsService = new AnalyticsService(sharedPool);

