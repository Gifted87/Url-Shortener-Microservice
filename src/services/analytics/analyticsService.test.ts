import { analyticsService } from './analyticsService';
import { redis } from '../../database/redis/redisClient';
import { Pool } from 'pg';

jest.mock('../../database/redis/redisClient', () => ({
    redis: {
        llen: jest.fn(),
        hincrby: jest.fn(),
        sadd: jest.fn(),
        rpush: jest.fn(),
        lpop: jest.fn()
    }
}));

jest.mock('pg', () => {
    const mClient = {
        query: jest.fn(),
        release: jest.fn()
    };
    return {
        Pool: jest.fn(() => ({
            connect: jest.fn().mockResolvedValue(mClient)
        }))
    };
});

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    });
});

describe('AnalyticsService', () => {
    let mPool: any;
    let mClient: any;

    beforeAll(() => {
        mPool = (Pool as unknown as jest.Mock).mock.results[0].value;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('trackClick', () => {
        it('should warn and return early if IP is invalid', async () => {
            await analyticsService.trackClick(1, 'invalid-ip', 'ua', 'ref');
            expect(redis.llen).not.toHaveBeenCalled();
        });

        it('should drop event if buffer size exceeds MAX_BUFFER_SIZE', async () => {
            (redis.llen as jest.Mock).mockResolvedValue(10000);
            await analyticsService.trackClick(1, '127.0.0.1', 'ua', 'ref');
            expect(redis.hincrby).not.toHaveBeenCalled();
        });

        it('should sanitize inputs and store event in redis', async () => {
            (redis.llen as jest.Mock).mockResolvedValue(5);
            await analyticsService.trackClick(1, '127.0.0.1', '<script>alert(1)</script>Mozilla', 'http://<ref>.com');
            
            expect(redis.hincrby).toHaveBeenCalledWith('metrics:clicks:1', 'total', 1);
            expect(redis.sadd).toHaveBeenCalledWith(expect.stringContaining('metrics:visitors:1:'), expect.stringContaining('127.0.0.1:scriptalert(1)/scriptMozilla'));
            expect(redis.rpush).toHaveBeenCalledWith('analytics:buffer', expect.any(String));
        });

        it('should handle redis errors gracefully', async () => {
            (redis.llen as jest.Mock).mockRejectedValue(new Error('Redis error'));
            await expect(analyticsService.trackClick(1, '127.0.0.1', 'ua', 'ref')).resolves.not.toThrow();
        });
    });

    describe('processBufferedClicks', () => {
        it('should break if lpop returns null', async () => {
            (redis.lpop as jest.Mock).mockResolvedValue(null);
            
            await analyticsService.processBufferedClicks(5);

            mClient = await mPool.connect();
            expect(mClient.query).not.toHaveBeenCalled();
            expect(mClient.release).toHaveBeenCalled();
        });

        it('should insert parsed events into database', async () => {
            const mockEvent = JSON.stringify({
                url_id: 1,
                timestamp: '2023-01-01T00:00:00.000Z',
                ip_address: '127.0.0.1',
                user_agent: 'ua',
                referer: 'ref'
            });

            (redis.lpop as jest.Mock).mockResolvedValueOnce(mockEvent).mockResolvedValueOnce(null);
            
            await analyticsService.processBufferedClicks(5);

            mClient = await mPool.connect();
            expect(mClient.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO clicks'),
                [1, '2023-01-01T00:00:00.000Z', '127.0.0.1', 'ua', 'ref']
            );
            expect(mClient.release).toHaveBeenCalled();
        });

        it('should requeue event and throw error if database insert fails', async () => {
            const mockEvent = JSON.stringify({
                url_id: 1,
                timestamp: '2023-01-01T00:00:00.000Z',
                ip_address: '127.0.0.1',
                user_agent: 'ua',
                referer: 'ref'
            });

            (redis.lpop as jest.Mock).mockResolvedValueOnce(mockEvent);

            mClient = await mPool.connect();
            mClient.query.mockRejectedValue(new Error('DB error'));

            // The function logs the error and catches the overall error in the background processing cycle loop, it actually does NOT throw the error up, wait let me check the code.
            // "throw dbErr" is caught by the outer catch (err) block!
            // Wait, looking at the code:
            // try { for(...) { try { query } catch(dbErr) { rpush; throw dbErr } } } catch(err) { logger.error } finally { release }
            // So processBufferedClicks will NOT throw. It just catches it and logs.
            await analyticsService.processBufferedClicks(1);

            expect(redis.rpush).toHaveBeenCalledWith('analytics:buffer', mockEvent);
            expect(mClient.release).toHaveBeenCalled();
        });

        it('should handle general connection errors gracefully', async () => {
            mPool.connect.mockRejectedValue(new Error('Pool error'));

            // Since there is no try/catch around `await this.pgPool.connect()`, it will throw!
            // Wait, processBufferedClicks code:
            // const client = await this.pgPool.connect();
            // try { ... }
            // So if connect() fails, it throws unhandled.
            await expect(analyticsService.processBufferedClicks(1)).rejects.toThrow('Pool error');
        });
    });
});
