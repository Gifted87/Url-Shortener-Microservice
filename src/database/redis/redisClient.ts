import Redis, { RedisOptions } from 'ioredis';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'test') {
    dotenv.config();
}

/**
 * Interface for Redis configuration injected via environment variables.
 */
interface RedisConfig {
    host: string;
    port: number;
    password?: string;
    db: number;
}

const config: RedisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0', 10),
};

/**
 * Singleton Redis client wrapper to ensure high-performance, stable connection management.
 */
class RedisClient {
    private client: Redis;

    constructor() {
        if (process.env.REDIS_URL) {
            this.client = new Redis(process.env.REDIS_URL, {
                retryStrategy: (times: number) => Math.min(times * 50, 2000),
                maxRetriesPerRequest: 3,
            });
        } else {
            this.client = new Redis({
                host: config.host,
                port: config.port,
                password: config.password,
                db: config.db,
                retryStrategy: (times: number) => Math.min(times * 50, 2000),
                maxRetriesPerRequest: 3,
            });
        }

        this.client.on('connect', () => console.info('Redis connected successfully.'));
        this.client.on('ready', () => console.info('Redis ready for operations.'));
        this.client.on('error', (err: Error) => console.error('Redis connection error:', err.message));
        this.client.on('close', () => console.warn('Redis connection closed.'));
    }

    /**
     * Executes a GET command.
     */
    async get(key: string): Promise<string | null> {
        return await this.client.get(key);
    }

    /**
     * Executes a SET command with expiration.
     */
    async set(key: string, value: string, ttlSeconds?: number): Promise<string | null> {
        if (ttlSeconds) {
            return await this.client.set(key, value, 'EX', ttlSeconds);
        }
        return await this.client.set(key, value);
    }

    /**
     * Increments a hash field value.
     */
    async hincrby(key: string, field: string, increment: number): Promise<number> {
        return await this.client.hincrby(key, field, increment);
    }

    /**
     * Adds members to a set.
     */
    async sadd(key: string, member: string): Promise<number> {
        return await this.client.sadd(key, member);
    }

    /**
     * Pushes a value to a list.
     */
    async rpush(key: string, value: string): Promise<number> {
        return await this.client.rpush(key, value);
    }

    /**
     * Executes a pipeline for batch operations.
     * If no commands are provided, returns a chainable pipeline object.
     */
    pipeline(commands?: Array<[string, ...any[]]>): any {
        const pipeline = this.client.pipeline();
        if (!commands) {
            return pipeline;
        }
        
        commands.forEach((cmd) => {
            const [method, ...args] = cmd;
            (pipeline as any)[method](...args);
        });
        return pipeline.exec();
    }

    /**
     * Returns the length of a list.
     */
    async llen(key: string): Promise<number> {
        return await this.client.llen(key);
    }

    /**
     * Removes and returns the first element of a list.
     */
    async lpop(key: string): Promise<string | null> {
        return await this.client.lpop(key);
    }

    /**
     * Sets expiration for a key.
     */
    async expire(key: string, seconds: number): Promise<number> {
        return await this.client.expire(key, seconds);
    }


    /**
     * Gracefully closes the connection.
     */
    async quit(): Promise<'OK'> {
        return await this.client.quit();
    }

    /**
     * Pings the server.
     */
    async ping(): Promise<string> {
        return await this.client.ping();
    }
}

export const redis = new RedisClient();
