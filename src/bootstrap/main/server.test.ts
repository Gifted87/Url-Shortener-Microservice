import express from 'express';
import http from 'http';
import { createServer, startServer } from './server';
import { config } from '../../config/env';
import { helmetMiddleware } from '../../middleware/security/securityMiddleware';

jest.mock('pino', () => {
    return Object.assign(
        () => ({
            info: jest.fn(),
            error: jest.fn(),
            fatal: jest.fn()
        }),
        {
            stdTimeFunctions: { isoTime: jest.fn() }
        }
    );
});

jest.mock('../../config/env', () => ({
    config: {
        PORT: 3000,
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgres://localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379/0',
        BASE_URL: 'http://localhost:3000'
    }
}));

jest.mock('../../middleware/security/securityMiddleware', () => ({
    helmetMiddleware: jest.fn((req, res, next) => next()),
    requestSanitizationMiddleware: jest.fn((req, res, next) => next()),
    securityMiddleware: jest.fn((req, res, next) => next())
}));

jest.mock('../../middleware/rate_limiter', () => ({
    rateLimiter: jest.fn((req, res, next) => next())
}));

jest.mock('../health/health', () => ({
    HealthController: {
        createRouter: jest.fn(() => {
            const router = require('express').Router();
            router.get('/health/live', (req: any, res: any) => res.status(200).json({ status: 'UP' }));
            return router;
        })
    }
}));

jest.mock('../lifecycle/shutdown', () => ({
    ShutdownManager: jest.fn().mockImplementation((server, pool) => ({
        initialize: jest.fn(() => {
            process.on('SIGTERM', () => {
                server.close(() => {
                    process.exit(0);
                });
            });
            process.on('SIGINT', () => {
                server.close(() => {
                    process.exit(0);
                });
            });
        })
    }))
}));

jest.mock('../../database/postgres/pool', () => ({
    pool: {}
}));



jest.mock('../../routes/shortener', () => {
    const express = require('express');
    const router = express.Router();
    return router;
});

jest.mock('../../database/redis/redisClient', () => ({
    redis: {
        set: jest.fn(),
        get: jest.fn(),
        quit: jest.fn(),
        pipeline: jest.fn(),
        expire: jest.fn()
    }
}));


describe('Server Bootstrap', () => {
    let originalExit: any;
    let originalOn: any;
    let mockServer: any;

    beforeEach(() => {
        jest.clearAllMocks();
        
        originalExit = process.exit;
        originalOn = process.on;

        process.exit = jest.fn() as any;
        process.on = jest.fn() as any;

        mockServer = {
            listen: jest.fn((port, cb) => cb()),
            on: jest.fn(),
            address: jest.fn(() => ({ port: 3000 })),
            close: jest.fn((cb) => cb())
        };
    });


    afterEach(() => {
        process.exit = originalExit;
        process.on = originalOn;
        jest.restoreAllMocks();
    });

    describe('createServer', () => {
        it('should configure express app with middlewares and health route', async () => {
            const app = createServer();
            expect(app).toBeDefined();

            // Simple check by invoking the health route using supertest
            const request = require('supertest');
            const res = await request(app).get('/health/live');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('UP');
        });

        it('should exit with 1 if initialization fails', () => {
            jest.spyOn(express.application, 'use').mockImplementationOnce(() => { throw new Error('Init fail'); });

            createServer();

            expect(process.exit).toHaveBeenCalledWith(1);
        });
    });

    describe('startServer', () => {
        beforeEach(() => {
            jest.spyOn(http, 'createServer').mockReturnValue(mockServer as any);
        });

        it('should start http server and resolve', async () => {
            await startServer();

            expect(http.createServer).toHaveBeenCalled();
            expect(mockServer.listen).toHaveBeenCalledWith(3000, expect.any(Function));
            expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
            expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        });


        it('should reject and exit if EADDRINUSE', async () => {
            mockServer.listen.mockImplementationOnce(() => {}); // Do not resolve
            mockServer.on.mockImplementation((event: string, cb: Function) => {
                if (event === 'error') {
                    cb({ code: 'EADDRINUSE' });
                }
            });

            await startServer();

            expect(process.exit).toHaveBeenCalledWith(1);
        });

        it('should register graceful shutdown logic', async () => {
            jest.useFakeTimers();
            await startServer();

        const mockOn = process.on as jest.Mock;
        const sigtermCall = mockOn.mock.calls.find(call => call[0] === 'SIGTERM');
        const sigtermHandler = sigtermCall[1];

        // Trigger shutdown
        sigtermHandler();

        expect(mockServer.close).toHaveBeenCalled();
        expect(process.exit).toHaveBeenCalledWith(0);
            
            jest.useRealTimers();
        });
    });
});
