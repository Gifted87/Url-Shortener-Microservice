import { urlService } from './urlService';
import { Pool, PoolClient } from 'pg';
import { redis } from '../../database/redis/redisClient';
import { generateAlias } from '../../utils/hashing/aliasGenerator';

jest.mock('pg', () => {
    const mClient = {
        query: jest.fn(),
        release: jest.fn()
    };
    return {
        Pool: jest.fn(() => ({
            connect: jest.fn().mockResolvedValue(mClient),
            query: jest.fn()
        }))
    };
});

jest.mock('../../database/redis/redisClient', () => ({
    redis: {
        set: jest.fn(),
        get: jest.fn()
    }
}));

jest.mock('../../utils/hashing/aliasGenerator', () => ({
    generateAlias: jest.fn()
}));

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        error: jest.fn()
    });
});

describe('UrlService', () => {
    let mPool: jest.Mocked<Pool>;
    let mClient: jest.Mocked<PoolClient>;

    beforeAll(() => {
        mPool = (Pool as unknown as jest.Mock).mock.results[0].value;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mPool.connect().then(c => mClient = c as any);
    });

    describe('shortenUrl', () => {
        it('should shorten url, update database, and warm cache', async () => {
            const originalUrl = 'https://example.com';
            const ownerId = 'user1';
            const mockId = '123';
            const mockAlias = 'bC';

            (generateAlias as jest.Mock).mockReturnValue(mockAlias);

            mClient.query.mockImplementation(async (queryText: any) => {
                if (typeof queryText === 'string' && queryText.includes('INSERT INTO urls')) {
                    return { rows: [{ id: mockId, alias: 'temp' }] };
                }
                return { rows: [] };
            });

            const alias = await urlService.shortenUrl(originalUrl, ownerId);

            expect(mClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO urls'), ['temp', originalUrl, ownerId]);
            expect(generateAlias).toHaveBeenCalledWith(123n);
            expect(mClient.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE urls SET alias'), [mockAlias, BigInt(123)]);
            expect(mClient.query).toHaveBeenCalledWith('COMMIT');
            expect(redis.set).toHaveBeenCalledWith(`url:${mockAlias}`, originalUrl, 86400);
            expect(alias).toBe(mockAlias);
            expect(mClient.release).toHaveBeenCalled();
        });

        it('should rollback transaction and throw error on failure', async () => {
            mClient.query.mockImplementation(async (queryText: any) => {
                if (typeof queryText === 'string' && queryText.includes('INSERT INTO urls')) {
                    throw new Error('DB error');
                }
            });

            await expect(urlService.shortenUrl('https://example.com')).rejects.toThrow('Internal server error during URL creation');
            
            expect(mClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mClient.release).toHaveBeenCalled();
        });
    });

    describe('resolveUrl', () => {
        it('should return url from cache if available', async () => {
            const mockAlias = 'bC';
            const originalUrl = 'https://example.com';

            (redis.get as jest.Mock).mockResolvedValue(originalUrl);

            const result = await urlService.resolveUrl(mockAlias);

            expect(redis.get).toHaveBeenCalledWith(`url:${mockAlias}`);
            expect(mPool.query).not.toHaveBeenCalled();
            expect(result).toBe(originalUrl);
        });

        it('should return url from database and set cache if cache miss', async () => {
            const mockAlias = 'bC';
            const originalUrl = 'https://example.com';

            (redis.get as jest.Mock).mockResolvedValue(null);
            (mPool.query as jest.Mock).mockResolvedValue({ rows: [{ original_url: originalUrl }] });

            const result = await urlService.resolveUrl(mockAlias);

            expect(redis.get).toHaveBeenCalledWith(`url:${mockAlias}`);
            expect(mPool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT original_url FROM urls'), [mockAlias]);
            expect(redis.set).toHaveBeenCalledWith(`url:${mockAlias}`, originalUrl, 86400);
            expect(result).toBe(originalUrl);
        });

        it('should return null if url is not found in database', async () => {
            const mockAlias = 'bC';

            (redis.get as jest.Mock).mockResolvedValue(null);
            (mPool.query as jest.Mock).mockResolvedValue({ rows: [] });

            const result = await urlService.resolveUrl(mockAlias);

            expect(result).toBeNull();
            expect(redis.set).not.toHaveBeenCalled();
        });

        it('should throw error on database failure during resolution', async () => {
            (redis.get as jest.Mock).mockRejectedValue(new Error('Redis down'));

            await expect(urlService.resolveUrl('alias')).rejects.toThrow('Internal server error during resolution');
        });
    });
});
