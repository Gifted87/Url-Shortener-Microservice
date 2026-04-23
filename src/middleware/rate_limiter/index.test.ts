import { rateLimiter } from './index';
import { Request, Response, NextFunction } from 'express';
import { redis } from '../../database/redis/redisClient';

jest.mock('../../database/redis/redisClient', () => ({
    redis: {
        pipeline: jest.fn(),
        set: jest.fn(),
        expire: jest.fn()
    }
}));

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    });
});

describe('rateLimiter middleware', () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    let next: NextFunction;

    beforeEach(() => {
        jest.clearAllMocks();
        
        req = {
            ip: '127.0.0.1'
        };
        
        res = {
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };

        next = jest.fn();
    });

    it('should allow request and set headers if under limit', async () => {
        (redis.pipeline as jest.Mock).mockResolvedValue([
            [null, 5],
            [null, 1], // expire NX result
            [null, 30] // ttl
        ]);

        await rateLimiter(req as Request, res as Response, next);

        expect(redis.pipeline).toHaveBeenCalledWith([
            ['incr', 'ratelimit:127.0.0.1'],
            ['expire', 'ratelimit:127.0.0.1', 60, 'NX'],
            ['ttl', 'ratelimit:127.0.0.1']
        ]);
        
        expect(redis.expire).not.toHaveBeenCalled(); // since ttl is not -1
        expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(String));
        expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
        expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
        
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('should block request if over limit', async () => {
        (redis.pipeline as jest.Mock).mockResolvedValue([
            [null, 150], // max is 100
            [null, 0], // expire NX result (key already exists)
            [null, 10] // ttl
        ]);

        await rateLimiter(req as Request, res as Response, next);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            status: 429,
            message: 'Too Many Requests',
            retry_after: 10
        }));
        expect(next).not.toHaveBeenCalled();
    });

    it('should set expiration as fallback if TTL is still -1', async () => {
        (redis.pipeline as jest.Mock).mockResolvedValue([
            [null, 1], // first request
            [null, 0], // expire NX failed for some reason
            [null, -1] // still no ttl
        ]);

        await rateLimiter(req as Request, res as Response, next);

        expect(redis.expire).toHaveBeenCalledWith('ratelimit:127.0.0.1', expect.any(Number));
        expect(next).toHaveBeenCalled();
    });

    it('should fail-open and call next if redis errors', async () => {
        (redis.pipeline as jest.Mock).mockRejectedValue(new Error('Redis down'));

        await rateLimiter(req as Request, res as Response, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('should fail-open if incr returns error', async () => {
        (redis.pipeline as jest.Mock).mockResolvedValue([
            [new Error('Incr error'), null],
            [null, null],
            [null, null]
        ]);

        await rateLimiter(req as Request, res as Response, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });
});

