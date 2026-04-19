import { Server } from 'http';
import pino from 'pino';
import { Pool } from 'pg';
import { redis } from '../../database/redis/redisClient';
import { analyticsService } from '../../services/analytics/analyticsService';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * ShutdownManager orchestrates a graceful termination of the service.
 * It handles connection draining, telemetry flushing, and resource cleanup.
 */
export class ShutdownManager {
    private readonly server: Server;
    private readonly pgPool: Pool;
    private readonly SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10);

    constructor(server: Server, pgPool: Pool) {
        this.server = server;
        this.pgPool = pgPool;
    }

    /**
     * Initializes signal listeners for graceful shutdown.
     */
    public initialize(): void {
        process.on('SIGTERM', () => this.handleSignal('SIGTERM'));
        process.on('SIGINT', () => this.handleSignal('SIGINT'));
    }

    private async handleSignal(signal: string): Promise<void> {
        logger.info({ signal }, 'Shutdown signal received. Starting graceful shutdown sequence.');

        try {
            // 1. Stop accepting new connections
            await this.drainServer();

            // 2. Flush Analytics Telemetry
            await this.flushAnalytics();

            // 3. Decommission Resource Pools
            await this.closeResources();

            logger.info('Graceful shutdown completed successfully.');
            process.exit(0);
        } catch (err) {
            logger.fatal({ err }, 'Critical failure during graceful shutdown.');
            process.exit(1);
        }
    }

    private drainServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            logger.info('Draining HTTP connections...');
            const timer = setTimeout(() => {
                logger.warn('Shutdown timed out. Forcing termination.');
                reject(new Error('Server close timed out'));
            }, this.SHUTDOWN_TIMEOUT_MS);

            this.server.close((err) => {
                clearTimeout(timer);
                if (err) {
                    logger.error({ err }, 'Error during server close');
                    reject(err);
                } else {
                    logger.info('HTTP server closed.');
                    resolve();
                }
            });
        });
    }

    private async flushAnalytics(): Promise<void> {
        logger.info('Initiating analytics flush...');
        try {
            await analyticsService.processBufferedClicks(500);
            logger.info('Analytics flush completed.');
        } catch (err) {
            logger.error({ err }, 'Initial analytics flush failed. Retrying...');
            try {
                await analyticsService.processBufferedClicks(500);
                logger.info('Retry analytics flush successful.');
            } catch (retryErr) {
                logger.error({ retryErr }, 'Final analytics flush retry failed. Data may be lost.');
                // Proceed despite failure to ensure process termination
            }
        }
    }

    private async closeResources(): Promise<void> {
        logger.info('Closing database and cache pools...');
        
        try {
            // PostgreSQL Close
            await this.pgPool.end();
            logger.info('PostgreSQL pool closed.');
        } catch (err) {
            logger.error({ err }, 'Error closing PostgreSQL pool.');
        }

        try {
            // Redis Close
            // Assuming redis client has a quit method for graceful disconnect
            await (redis as any).quit();
            logger.info('Redis connection closed.');
        } catch (err) {
            logger.error({ err }, 'Error closing Redis connection.');
        }
    }
}
