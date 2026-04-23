import { urlService } from './urlService';
import { Pool, PoolClient } from 'pg';
import { redis } from '../../database/redis/redisClient';
import { generateAlias } from '../../utils/hashing/aliasGenerator';
import { pool } from '../../database/postgres/pool';

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

jest.mock('../../database/postgres/pool', () => ({
    pool: {
        connect: jest.fn(),
        query: jest.fn()
    }
}));

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
        error: jest.fn(),
        debug: jest.fn()
    });
});

describe('UrlService', () => {
    let mClient: any;

    beforeEach(async () => {
        jest.clearAllMocks();
        
        mClient = {
            query: jest.fn(),
            release: jest.fn()
        };

        (pool.connect as jest.Mock).mockResolvedValue(mClient);
        (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
    });




    describe('shortenUrl', () => {
        it('should reserve ID via nextval, shorten url, and warm cache', async () => {
            const originalUrl = 'https://example.com';
            const ownerId = 'user1';
            const mockId = 123n;
            const mockAlias = 'bC';

            (generateAlias as jest.Mock).mockReturnValue(mockAlias);

            mClient.query.mockImplementation(async (queryText: any) => {
                if (typeof queryText === 'string' && queryText.includes("nextval('urls_id_seq')")) {
                    return { rows: [{ id: '123' }] };
                }
                if (typeof queryText === 'string' && queryText.includes('INSERT INTO urls')) {
                    return { rows: [{ alias: mockAlias }] };
                }
                return { rows: [] };
            });

            const alias = await urlService.shortenUrl(originalUrl, ownerId);

            expect(mClient.query).toHaveBeenCalledWith('BEGIN');
            expect(mClient.query).toHaveBeenCalledWith("SELECT nextval('urls_id_seq') as id");
            expect(generateAlias).toHaveBeenCalledWith(mockId);
            expect(mClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO urls'), [mockId.toString(), mockAlias, originalUrl, ownerId]);
            expect(mClient.query).toHaveBeenCalledWith('COMMIT');
            expect(redis.set).toHaveBeenCalledWith(`url:${mockAlias}`, expect.stringContaining(`"id":"${mockId}"`), 86400);
            expect(alias).toBe(mockAlias);
            expect(mClient.release).toHaveBeenCalled();
        });

        it('should rollback transaction and throw error on failure', async () => {
            mClient.query.mockImplementation(async (queryText: any) => {
                if (typeof queryText === 'string' && queryText.includes('nextval')) {
                    throw new Error('DB error');
                }
            });

            await expect(urlService.shortenUrl('https://example.com')).rejects.toThrow('Internal server error during URL creation');
            
            expect(mClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mClient.release).toHaveBeenCalled();
        });
    });

    describe('resolveUrl', () => {
        it('should return record from cache if available', async () => {
            const mockAlias = 'bC';
            const mockRecord = { id: '123', alias: 'bC', original_url: 'https://example.com', created_at: new Date().toISOString() };

            (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockRecord));

            const result = await urlService.resolveUrl(mockAlias);

            expect(redis.get).toHaveBeenCalledWith(`url:${mockAlias}`);
            expect(pool.query).not.toHaveBeenCalled();
            expect(result?.id).toBe(123n);
            expect(result?.original_url).toBe(mockRecord.original_url);
        });

        it('should return record from database and set cache if cache miss', async () => {
            const mockAlias = 'bC';
            const mockDbRow = { id: '123', alias: 'bC', original_url: 'https://example.com', owner_id: null, created_at: new Date() };

            (redis.get as jest.Mock).mockResolvedValue(null);
            (pool.query as jest.Mock).mockResolvedValue({ rows: [mockDbRow] });

            const result = await urlService.resolveUrl(mockAlias);

            expect(redis.get).toHaveBeenCalledWith(`url:${mockAlias}`);
            expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT id, alias, original_url'), [mockAlias]);
            expect(redis.set).toHaveBeenCalled();
            expect(result?.original_url).toBe(mockDbRow.original_url);
        });

        it('should return null if url is not found in database', async () => {
            const mockAlias = 'bC';

            (redis.get as jest.Mock).mockResolvedValue(null);
            (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

            const result = await urlService.resolveUrl(mockAlias);

            expect(result).toBeNull();
            expect(redis.set).not.toHaveBeenCalled();
        });


        it('should fail-open and query database if Redis lookup fails', async () => {
            const mockAlias = 'bC';
            const mockDbRow = { id: '123', alias: 'bC', original_url: 'https://example.com', owner_id: null, created_at: new Date() };

            (redis.get as jest.Mock).mockRejectedValue(new Error('Redis down'));
            (pool.query as jest.Mock).mockResolvedValue({ rows: [mockDbRow] });

            const result = await urlService.resolveUrl(mockAlias);

            expect(result?.original_url).toBe(mockDbRow.original_url);
            expect(pool.query).toHaveBeenCalled();
        });

        it('should throw error if both Redis and Database fail', async () => {
            (redis.get as jest.Mock).mockRejectedValue(new Error('Redis down'));
            (pool.query as jest.Mock).mockRejectedValue(new Error('DB down'));

            await expect(urlService.resolveUrl('alias')).rejects.toThrow('Internal server error during resolution');
        });
    });
});

