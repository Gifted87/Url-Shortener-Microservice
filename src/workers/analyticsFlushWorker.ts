import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import pino from 'pino';
import { isIP } from 'net';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'test') {
    dotenv.config();
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface ClickEvent {
    url_id: number;
    timestamp: string;
    ip_address: string;
    user_agent: string;
    referer: string;
}

/**
 * AnalyticsFlushWorker manages the high-throughput migration of click telemetry
 * from Redis buffers to PostgreSQL.
 */
export class AnalyticsFlushWorker {
    private readonly pgPool: Pool;
    private readonly redis: Redis;
    private readonly bufferKey = 'analytics:buffer';
    private readonly batchSize: number;
    private readonly intervalMs: number;
    private isRunning = false;
    private intervalHandle: NodeJS.Timeout | null = null;

    constructor(pgPool: Pool, redis: Redis) {
        this.pgPool = pgPool;
        this.redis = redis;
        this.batchSize = parseInt(process.env.ANALYTICS_BATCH_SIZE || '500', 10);
        this.intervalMs = parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS || '5000', 10);
    }

    private sanitize(value: string | undefined): string {
        if (!value) return '';
        // Strip basic HTML/script tags and limit length
        return value.replace(/<[^>]*>?/gm, '').trim().substring(0, 512);
    }

    private validateEvent(event: any): event is ClickEvent {
        return (
            typeof event.url_id === 'number' &&
            typeof event.timestamp === 'string' &&
            isIP(event.ip_address) !== 0 &&
            typeof event.user_agent === 'string' &&
            typeof event.referer === 'string'
        );
    }

    private async flush(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;

        const events: string[] = [];
        try {
            // Atomically retrieve a batch
            const pipeline = this.redis.pipeline();
            for (let i = 0; i < this.batchSize; i++) {
                pipeline.lpop(this.bufferKey);
            }
            const results = await pipeline.exec();
            
            if (!results) return;

            for (const [err, rawEvent] of results) {
                if (err) continue;
                if (typeof rawEvent === 'string') {
                    events.push(rawEvent);
                }
            }

            if (events.length === 0) return;

            await this.persistBatch(events);
        } catch (err) {
            logger.error({ err }, 'Error during flush cycle');
            // Re-queue events on failure
            for (const rawEvent of events) {
                await this.redis.rpush(this.bufferKey, rawEvent);
            }
        } finally {
            this.isRunning = false;
        }
    }

    private async persistBatch(rawEvents: string[]): Promise<void> {
        const client: PoolClient = await this.pgPool.connect();
        try {
            await client.query('BEGIN');
            
            for (const raw of rawEvents) {
                const event = JSON.parse(raw);
                if (!this.validateEvent(event)) {
                    logger.warn({ event }, 'Discarding malformed analytics event');
                    continue;
                }

                await client.query(
                    `INSERT INTO clicks (url_id, timestamp, ip_address, user_agent, referer) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [
                        event.url_id,
                        event.timestamp,
                        event.ip_address,
                        this.sanitize(event.user_agent),
                        this.sanitize(event.referer)
                    ]
                );
            }
            
            await client.query('COMMIT');
            logger.info({ count: rawEvents.length }, 'Successfully flushed batch to PostgreSQL');
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error({ err }, 'Database transaction failed, re-queueing batch');
            for (const raw of rawEvents) {
                await this.redis.rpush(this.bufferKey, raw);
            }
            throw err;
        } finally {
            client.release();
        }
    }

    public start(): void {
        logger.info('AnalyticsFlushWorker starting');
        this.intervalHandle = setInterval(() => this.flush(), this.intervalMs);
    }

    public async stop(): Promise<void> {
        logger.info('AnalyticsFlushWorker shutting down');
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
        }
        // One final flush to clear remaining items
        await this.flush();
    }
}
