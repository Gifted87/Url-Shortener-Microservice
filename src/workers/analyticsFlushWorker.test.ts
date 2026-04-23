import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import { AnalyticsFlushWorker } from './analyticsFlushWorker';

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    });
});

describe('AnalyticsFlushWorker', () => {
    let pgPool: jest.Mocked<Pool>;
    let mClient: jest.Mocked<PoolClient>;
    let redis: jest.Mocked<Redis>;
    let worker: AnalyticsFlushWorker;

    beforeEach(() => {
        jest.clearAllMocks();

        mClient = {
            query: jest.fn(),
            release: jest.fn()
        } as unknown as jest.Mocked<PoolClient>;

        pgPool = {
            connect: jest.fn().mockResolvedValue(mClient)
        } as unknown as jest.Mocked<Pool>;

        redis = {
            pipeline: jest.fn(() => ({
                lpop: jest.fn(),
                exec: jest.fn().mockResolvedValue([
                    [null, JSON.stringify({
                        url_id: '1',
                        timestamp: '2023-01-01',
                        ip_address: '127.0.0.1',
                        user_agent: 'agent',
                        referer: 'ref'
                    })],
                    [null, null]
                ])
            })),
            rpush: jest.fn()
        } as unknown as jest.Mocked<Redis>;

        process.env.ANALYTICS_BATCH_SIZE = '2';
        process.env.ANALYTICS_FLUSH_INTERVAL_MS = '1000';

        worker = new AnalyticsFlushWorker(pgPool, redis);
    });

    afterEach(async () => {
        await worker.stop();
    });

    it('should start and clear intervals', async () => {
        jest.useFakeTimers();
        jest.spyOn(global, 'setInterval');
        jest.spyOn(global, 'clearInterval');
        worker.start();
        
        expect(global.setInterval).toHaveBeenCalled();
        
        await worker.stop();
        expect(global.clearInterval).toHaveBeenCalled();
        jest.useRealTimers();
    });

    it('should flush events from redis to postgres using bulk insert', async () => {
        await (worker as any).flush();

        expect(mClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mClient.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO clicks'),
            ['1', '2023-01-01', '127.0.0.1', 'agent', 'ref']
        );
        expect(mClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mClient.release).toHaveBeenCalled();
    });

    it('should discard malformed events and NOT block the batch', async () => {
        (redis.pipeline as jest.Mock).mockReturnValueOnce({
            lpop: jest.fn(),
            exec: jest.fn().mockResolvedValue([
                [null, JSON.stringify({
                    url_id: 'not-a-number', // invalid
                    timestamp: '2023-01-01',
                    ip_address: '127.0.0.1',
                    user_agent: 'agent',
                    referer: 'ref'
                })],
                [null, JSON.stringify({
                    url_id: '2',
                    timestamp: '2023-01-01',
                    ip_address: '127.0.0.1',
                    user_agent: 'agent',
                    referer: 'ref'
                })]
            ])
        });

        await (worker as any).flush();

        expect(mClient.query).toHaveBeenCalledWith('BEGIN');
        // Should only insert the valid one
        expect(mClient.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO clicks'),
            ['2', '2023-01-01', '127.0.0.1', 'agent', 'ref']
        );
        expect(mClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should discard batch on persistent DB error to prevent poison pill loop', async () => {
        mClient.query.mockImplementation(async (queryText) => {
            if (typeof queryText === 'string' && queryText.startsWith('INSERT')) {
                const err: any = new Error('FK violation');
                err.code = '23503'; // Not transient
                throw err;
            }
        });

        await (worker as any).flush();

        expect(mClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(redis.rpush).not.toHaveBeenCalled(); // Discarded
        expect(mClient.release).toHaveBeenCalled();
    });

    it('should rollback transaction and requeue events on transient DB failure', async () => {
        mClient.query.mockImplementation(async (queryText) => {
            if (typeof queryText === 'string' && queryText.startsWith('INSERT')) {
                const err: any = new Error('Connection lost');
                err.code = '08006'; // Transient
                throw err;
            }
        });

        const rawEvent = JSON.stringify({
            url_id: '1',
            timestamp: '2023-01-01',
            ip_address: '127.0.0.1',
            user_agent: 'agent',
            referer: 'ref'
        });

        (redis.pipeline as jest.Mock).mockReturnValueOnce({
            lpop: jest.fn(),
            exec: jest.fn().mockResolvedValue([
                [null, rawEvent]
            ])
        });

        await (worker as any).flush();

        expect(mClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(redis.rpush).toHaveBeenCalledWith('analytics:buffer', rawEvent);
        expect(mClient.release).toHaveBeenCalled();
    });

    it('should skip flush if already running', async () => {
        (worker as any).isRunning = true;
        await (worker as any).flush();
        expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('should handle general pipeline exec errors gracefully', async () => {
        (redis.pipeline as jest.Mock).mockReturnValueOnce({
            lpop: jest.fn(),
            exec: jest.fn().mockRejectedValue(new Error('Redis error'))
        });

        await expect((worker as any).flush()).resolves.not.toThrow();
        expect(redis.rpush).not.toHaveBeenCalled(); // since no events were retrieved
    });
});
