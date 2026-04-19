import { Request, Response, NextFunction } from 'express';
import { redis } from '../../database/redis/redisClient';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Configuration constants for the Rate Limiter middleware.
 * Retrieved from process.env with defaults for production robustness.
 */
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
const RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10);

/**
 * Express middleware implementing a Fixed Window Counter rate limiter.
 * Offloads state management to Redis using atomic operations.
 * 
 * Logic:
 * 1. Identify client by IP (req.ip).
 * 2. Use Redis INCR command to increment a key scoped to the window.
 * 3. If INCR result is 1, it's the start of the window: set EXPIRE.
 * 4. Check against quota.
 * 5. Fail-open if Redis is unreachable.
 */
export const rateLimiter = async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `ratelimit:${ip}`;

    try {
        // Atomic increment using a pipeline to ensure EXPIRE is set on initialization
        // We utilize the underlying ioredis client's pipeline capability via our Redis client
        // @ts-ignore: Accessing the underlying raw client for atomic pipeline logic
        const results = await redis.pipeline([
            ['incr', key],
            ['ttl', key]
        ]);

        const [[errIncr, count], [errTtl, ttl]] = results;

        if (errIncr) throw new Error(`Redis INCR error: ${errIncr}`);

        const currentCount = count as number;
        
        // If it's the first request, set the expiration
        if (currentCount === 1) {
            await redis.set(key, '1', RATE_LIMIT_WINDOW_SECONDS);
        }

        const remaining = Math.max(0, RATE_LIMIT_MAX - currentCount);
        const resetTime = Math.floor(Date.now() / 1000) + (ttl > 0 ? (ttl as number) : RATE_LIMIT_WINDOW_SECONDS);

        // Set standard rate limit headers
        res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX.toString());
        res.setHeader('X-RateLimit-Remaining', remaining.toString());
        res.setHeader('X-RateLimit-Reset', resetTime.toString());

        if (currentCount > RATE_LIMIT_MAX) {
            logger.warn({ ip, currentCount, limit: RATE_LIMIT_MAX }, 'Rate limit exceeded');
            return res.status(429).json({
                status: 429,
                message: 'Too Many Requests',
                retry_after: resetTime - Math.floor(Date.now() / 1000)
            });
        }

        next();
    } catch (error) {
        // Fail-open: log the error but allow the request to proceed
        logger.error({ error, ip }, 'Rate limiter failed, bypassing check');
        next();
    }
};
