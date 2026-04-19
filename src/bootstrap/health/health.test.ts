import { Request, Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { HealthController } from './health';

jest.mock('pino', () => {
    return () => ({
        error: jest.fn(),
        info: jest.fn()
    });
});

describe('HealthController', () => {
    let pgPool: jest.Mocked<Pool>;
    let redisClient: jest.Mocked<Redis>;
    let controller: HealthController;
    let req: Partial<Request>;
    let res: Partial<Response>;

    beforeEach(() => {
        pgPool = {
            connect: jest.fn()
        } as unknown as jest.Mocked<Pool>;

        redisClient = {
            ping: jest.fn()
        } as unknown as jest.Mocked<Redis>;

        controller = new HealthController(pgPool, redisClient);

        req = {};
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    describe('live', () => {
        it('should return 200 UP', async () => {
            await controller.live(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ status: 'UP' });
        });
    });

    describe('ready', () => {
        it('should return 200 READY if both db and cache are OK', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({}),
                release: jest.fn()
            };
            (pgPool.connect as jest.Mock).mockResolvedValue(mockClient as any);
            redisClient.ping.mockResolvedValue('PONG');

            await controller.ready(req as Request, res as Response);

            expect(mockClient.release).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({
                status: 'READY',
                dependencies: {
                    database: 'OK',
                    cache: 'OK'
                }
            });
        });

        it('should return 503 UNAVAILABLE if database fails', async () => {
            (pgPool.connect as jest.Mock).mockRejectedValue(new Error('Connection error'));
            redisClient.ping.mockResolvedValue('PONG');

            await controller.ready(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({
                status: 'UNAVAILABLE',
                dependencies: {
                    database: 'FAIL',
                    cache: 'OK'
                }
            });
        });

        it('should return 503 UNAVAILABLE if redis fails', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({}),
                release: jest.fn()
            };
            (pgPool.connect as jest.Mock).mockResolvedValue(mockClient as any);
            redisClient.ping.mockRejectedValue(new Error('Redis error'));

            await controller.ready(req as Request, res as Response);

            expect(mockClient.release).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({
                status: 'UNAVAILABLE',
                dependencies: {
                    database: 'OK',
                    cache: 'FAIL'
                }
            });
        });

        it('should return 503 UNAVAILABLE if both fail', async () => {
            (pgPool.connect as jest.Mock).mockRejectedValue(new Error('DB error'));
            redisClient.ping.mockRejectedValue(new Error('Redis error'));

            await controller.ready(req as Request, res as Response);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({
                status: 'UNAVAILABLE',
                dependencies: {
                    database: 'FAIL',
                    cache: 'FAIL'
                }
            });
        });
    });
});
