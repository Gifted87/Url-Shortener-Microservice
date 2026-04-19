import { redis } from './redisClient';
import Redis from 'ioredis';

jest.mock('ioredis', () => {
    const mRedis: any = {
        on: jest.fn(),
        get: jest.fn(),
        set: jest.fn(),
        hincrby: jest.fn(),
        sadd: jest.fn(),
        rpush: jest.fn(),
        pipeline: jest.fn(() => ({
            get: jest.fn(),
            set: jest.fn(),
            exec: jest.fn().mockResolvedValue([['null', 'value']])
        })),
        llen: jest.fn(),
        lpop: jest.fn(),
        quit: jest.fn(),
        ping: jest.fn()
    };
    
    // simulate event emitters to prevent unhandled logs after tests
    mRedis.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'connect' || event === 'ready') {
           // Do not trigger immediately, just register
        }
    });
    return jest.fn(() => mRedis);
});

describe('RedisClient', () => {
    let mRedisInstance: any;

    beforeAll(() => {
        mRedisInstance = (Redis as unknown as jest.Mock).mock.results[0].value;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should call get correctly', async () => {
        mRedisInstance.get.mockResolvedValue('value');
        const res = await redis.get('key');
        expect(mRedisInstance.get).toHaveBeenCalledWith('key');
        expect(res).toBe('value');
    });

    it('should call set with ttl correctly', async () => {
        mRedisInstance.set.mockResolvedValue('OK');
        const res = await redis.set('key', 'value', 3600);
        expect(mRedisInstance.set).toHaveBeenCalledWith('key', 'value', 'EX', 3600);
        expect(res).toBe('OK');
    });

    it('should call set without ttl correctly', async () => {
        mRedisInstance.set.mockResolvedValue('OK');
        const res = await redis.set('key', 'value');
        expect(mRedisInstance.set).toHaveBeenCalledWith('key', 'value');
        expect(res).toBe('OK');
    });

    it('should call hincrby correctly', async () => {
        mRedisInstance.hincrby.mockResolvedValue(2);
        const res = await redis.hincrby('hash', 'field', 1);
        expect(mRedisInstance.hincrby).toHaveBeenCalledWith('hash', 'field', 1);
        expect(res).toBe(2);
    });

    it('should call sadd correctly', async () => {
        mRedisInstance.sadd.mockResolvedValue(1);
        const res = await redis.sadd('set', 'member');
        expect(mRedisInstance.sadd).toHaveBeenCalledWith('set', 'member');
        expect(res).toBe(1);
    });

    it('should call rpush correctly', async () => {
        mRedisInstance.rpush.mockResolvedValue(5);
        const res = await redis.rpush('list', 'value');
        expect(mRedisInstance.rpush).toHaveBeenCalledWith('list', 'value');
        expect(res).toBe(5);
    });

    it('should call pipeline correctly', async () => {
        const commands = [['get', 'key'], ['set', 'key2', 'val2']] as any;
        const res = await redis.pipeline(commands);
        expect(mRedisInstance.pipeline).toHaveBeenCalled();
        expect(res).toEqual([['null', 'value']]);
    });

    it('should call llen correctly', async () => {
        mRedisInstance.llen.mockResolvedValue(10);
        const res = await redis.llen('list');
        expect(mRedisInstance.llen).toHaveBeenCalledWith('list');
        expect(res).toBe(10);
    });

    it('should call lpop correctly', async () => {
        mRedisInstance.lpop.mockResolvedValue('val');
        const res = await redis.lpop('list');
        expect(mRedisInstance.lpop).toHaveBeenCalledWith('list');
        expect(res).toBe('val');
    });

    it('should call quit correctly', async () => {
        mRedisInstance.quit.mockResolvedValue('OK');
        const res = await redis.quit();
        expect(mRedisInstance.quit).toHaveBeenCalled();
        expect(res).toBe('OK');
    });

    it('should call ping correctly', async () => {
        mRedisInstance.ping.mockResolvedValue('PONG');
        const res = await redis.ping();
        expect(mRedisInstance.ping).toHaveBeenCalled();
        expect(res).toBe('PONG');
    });
});
