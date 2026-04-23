import { Pool, PoolClient } from 'pg';
import { pool as sharedPool } from '../database/postgres/pool';
import Redis from 'ioredis';
import pino from 'pino';
import { isIP } from 'net';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'test') {
    dotenv.config();
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface ClickEvent {
    url_id: string;
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
    private readonly redis: any;
    private readonly bufferKey = 'analytics:buffer';
    private readonly batchSize: number;
    private readonly intervalMs: number;
    private isRunning = false;
    private intervalHandle: NodeJS.Timeout | null = null;
    private dbPool: Pool;

    constructor(pgPool: Pool, redis: any) {
        this.pgPool = pgPool;
        this.dbPool = pgPool;
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
            ((typeof event.url_id === 'number') || (typeof event.url_id === 'string' && event.url_id.length > 0 && !isNaN(Number(event.url_id)))) &&
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
        } finally {
            this.isRunning = false;
        }
    }

    private async persistBatch(rawEvents: string[]): Promise<void> {
        const parsedEvents: ClickEvent[] = [];
        
        for (const raw of rawEvents) {
            try {
                const event = JSON.parse(raw);
                if (this.validateEvent(event)) {
                    parsedEvents.push(event);
                } else {
                    logger.warn({ event }, 'Discarding malformed analytics event: validation failed');
                }
            } catch (parseErr) {
                logger.error({ parseErr, raw }, 'Discarding unparseable analytics event');
            }
        }

        if (parsedEvents.length === 0) return;

        const client: PoolClient = await this.pgPool.connect();
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
            
            await client.query('BEGIN');
            await client.query(query, flatParams);
            await client.query('COMMIT');
            
            logger.info({ count: parsedEvents.length }, 'Successfully bulk flushed analytics batch');
        } catch (err: any) {
            await client.query('ROLLBACK');
            
            // If it's a constraint violation (like a foreign key error), we need to identify the bad record
            // or just log it and potentially lose the batch if we can't safely re-queue.
            // For now, we log the fatal error and re-queue only if it seems like a connection issue.
            const isTransient = err.code === '08001' || err.code === '08003' || err.code === '08006' || err.code === '57P01';
            
            if (isTransient) {
                logger.error({ err }, 'Transient database failure, re-queueing batch');
                for (const raw of rawEvents) {
                    await this.redis.rpush(this.bufferKey, raw);
                }
            } else {
                logger.error({ err }, 'Persistent database error during bulk insert. Discarding batch to prevent poison pill loop.');
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
            global.clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        // One final flush to clear remaining items
        await this.flush();
    }
}

