import { AnalyticsService } from './analyticsService';
import { redis } from '../../database/redis/redisClient';

jest.mock('../../database/redis/redisClient', () => ({
    redis: {
        llen: jest.fn(),
        hincrby: jest.fn(),
        sadd: jest.fn(),
        rpush: jest.fn(),
        lpop: jest.fn()
    }
}));

// Mock the shared pool so the module-level singleton doesn't open real connections
jest.mock('../../database/postgres/pool', () => ({
    pool: { connect: jest.fn() }
}));

jest.mock('pg', () => ({ Pool: jest.fn() }));

jest.mock('pino', () => () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

function makePool() {
    const client = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
    };
    const pool = {
        connect: jest.fn().mockResolvedValue(client)
    };
    return { pool, client };
}

describe('AnalyticsService', () => {
    let service: AnalyticsService;
    let pool: ReturnType<typeof makePool>['pool'];
    let client: ReturnType<typeof makePool>['client'];

    beforeEach(() => {
        jest.resetAllMocks();
        ({ pool, client } = makePool());
        service = new AnalyticsService(pool as any);
    });

    // ── trackClick ──────────────────────────────────────────────────────────

    describe('trackClick', () => {
        it('should return early without touching redis if IP is invalid', async () => {
            await service.trackClick('1', 'invalid-ip', 'ua', 'ref');
            expect(redis.llen).not.toHaveBeenCalled();
        });

        it('should drop event and not increment counters when buffer is full', async () => {
            (redis.llen as jest.Mock).mockResolvedValue(10000);
            await service.trackClick('1', '127.0.0.1', 'ua', 'ref');
            expect(redis.hincrby).not.toHaveBeenCalled();
        });

        it('should sanitize inputs and push event to redis buffer', async () => {
            (redis.llen as jest.Mock).mockResolvedValue(5);
            await service.trackClick(
                '1',
                '127.0.0.1',
                '<script>alert(1)</script>Mozilla',
                'http://<ref>.com'
            );

            expect(redis.hincrby).toHaveBeenCalledWith('metrics:clicks:1', 'total', 1);
            expect(redis.sadd).toHaveBeenCalledWith(
                expect.stringContaining('metrics:visitors:1:'),
                expect.stringContaining('127.0.0.1:scriptalert(1)/scriptMozilla')
            );
            expect(redis.rpush).toHaveBeenCalledWith('analytics:buffer', expect.any(String));
        });

        it('should resolve without throwing if redis errors', async () => {
            (redis.llen as jest.Mock).mockRejectedValue(new Error('Redis error'));
            await expect(
                service.trackClick('1', '127.0.0.1', 'ua', 'ref')
            ).resolves.not.toThrow();
        });
    });

    // ── processBufferedClicks ────────────────────────────────────────────────

    describe('processBufferedClicks', () => {
        it('should not connect to DB when buffer is empty', async () => {
            (redis.lpop as jest.Mock).mockResolvedValue(null);

            await service.processBufferedClicks(5);

            expect(pool.connect).not.toHaveBeenCalled();
        });

        it('should bulk-insert events and release the client', async () => {
            const event = JSON.stringify({
                url_id: '1',
                timestamp: '2023-01-01T00:00:00.000Z',
                ip_address: '127.0.0.1',
                user_agent: 'ua',
                referer: 'ref'
            });
            (redis.lpop as jest.Mock)
                .mockResolvedValueOnce(event)
                .mockResolvedValueOnce(null);

            await service.processBufferedClicks(5);

            expect(pool.connect).toHaveBeenCalledTimes(1);
            expect(client.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO clicks'),
                ['1', '2023-01-01T00:00:00.000Z', '127.0.0.1', 'ua', 'ref']
            );
            expect(client.release).toHaveBeenCalledTimes(1);
        });

        it('should requeue events and re-throw when bulk insert fails', async () => {
            const event = JSON.stringify({
                url_id: '1',
                timestamp: '2023-01-01T00:00:00.000Z',
                ip_address: '127.0.0.1',
                user_agent: 'ua',
                referer: 'ref'
            });
            (redis.lpop as jest.Mock)
                .mockResolvedValueOnce(event)
                .mockResolvedValueOnce(null);
            client.query.mockRejectedValue(new Error('DB error'));

            await expect(service.processBufferedClicks(1)).rejects.toThrow('DB error');

            expect(redis.rpush).toHaveBeenCalledWith('analytics:buffer', event);
            expect(client.release).toHaveBeenCalledTimes(1);
        });

        it('should propagate connection errors without swallowing them', async () => {
            // Use a dedicated service with a pool that always fails to connect.
            const rejectingPool = {
                connect: jest.fn().mockRejectedValue(new Error('Pool error'))
            };
            const svc = new AnalyticsService(rejectingPool as any);

            const event = JSON.stringify({
                url_id: '2',
                timestamp: '2023-01-01T00:00:00.000Z',
                ip_address: '192.168.1.1',
                user_agent: 'agent',
                referer: 'ref'
            });
            (redis.lpop as jest.Mock)
                .mockResolvedValueOnce(event)
                .mockResolvedValueOnce(null);

            await expect(svc.processBufferedClicks(1)).rejects.toThrow('Pool error');
        });
    });
});
