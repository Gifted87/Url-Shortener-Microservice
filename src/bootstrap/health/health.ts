import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * HealthController encapsulates the logic for service health probes.
 * Adheres to the infrastructure health contract for liveness and readiness monitoring.
 */
export class HealthController {
    private readonly pgPool: Pool;
    private readonly redisClient: any;
    private readonly dbTimeoutMs: number = 2000;

    constructor(pgPool: Pool, redisClient: any) {
        this.pgPool = pgPool;
        this.redisClient = redisClient;
    }

    /**
     * Liveness probe: Simply confirms the process is alive.
     */
    public async live(req: Request, res: Response): Promise<void> {
        res.status(200).json({ status: 'UP' });
    }

    /**
     * Readiness probe: Verifies connectivity to mandatory infrastructure dependencies.
     * Returns 503 if any critical dependency is unavailable.
     */
    public async ready(req: Request, res: Response): Promise<void> {
        try {
            const [dbOk, cacheOk] = await Promise.all([
                this.checkDatabase(),
                this.checkRedis()
            ]);

            if (dbOk && cacheOk) {
                res.status(200).json({
                    status: 'READY',
                    dependencies: {
                        database: 'OK',
                        cache: 'OK'
                    }
                });
            } else {
                res.status(503).json({
                    status: 'UNAVAILABLE',
                    dependencies: {
                        database: dbOk ? 'OK' : 'FAIL',
                        cache: cacheOk ? 'OK' : 'FAIL'
                    }
                });
            }
        } catch (error) {
            logger.error({ error }, 'Readiness probe encountered an unexpected error');
            res.status(503).json({ status: 'UNAVAILABLE', error: 'Service health check failed' });
        }
    }

    private async checkDatabase(): Promise<boolean> {
        let client;
        let timer: NodeJS.Timeout | undefined;
        try {
            client = await this.pgPool.connect();
            
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('DB_TIMEOUT')), this.dbTimeoutMs);
            });
            
            await Promise.race([
                client.query('SELECT 1'),
                timeoutPromise
            ]);
            return true;
        } catch (err) {
            logger.error({ err }, 'Database readiness check failed');
            return false;
        } finally {
            if (timer) clearTimeout(timer);
            if (client) client.release();
        }
    }

    private async checkRedis(): Promise<boolean> {
        try {
            const status = await this.redisClient.ping();
            return status === 'PONG';
        } catch (err) {
            logger.error({ err }, 'Redis readiness check failed');
            return false;
        }
    }

    /**
     * Factory method to generate the Router instance for the health endpoints.
     */
    public static createRouter(pgPool: Pool, redisClient: any): Router {
        const router = Router();
        const controller = new HealthController(pgPool, redisClient);

        router.get('/health/live', (req, res) => controller.live(req, res));
        router.get('/health/ready', (req, res) => controller.ready(req, res));

        return router;
    }
}
