import Joi from 'joi';

describe('Config environment validation', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let originalExit: typeof process.exit;
    let originalError: typeof console.error;

    beforeEach(() => {
        originalEnv = { ...process.env };
        originalExit = process.exit;
        originalError = console.error;

        process.exit = jest.fn() as any;
        console.error = jest.fn();

        jest.resetModules(); // clears the cache so env.ts is re-evaluated
    });

    afterEach(() => {
        process.env = originalEnv;
        process.exit = originalExit;
        console.error = originalError;
    });

    it('should load default values if not provided (except required ones)', () => {
        process.env = {
            DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
            REDIS_URL: 'redis://localhost:6379',
        };

        const { config } = require('./env');

        expect(config.NODE_ENV).toBe('development');
        expect(config.PORT).toBe(3000);
        expect(config.LOG_LEVEL).toBe('info');
        expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10000);
        expect(config.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/db');
        expect(config.REDIS_URL).toBe('redis://localhost:6379');
        
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('should override defaults with environment variables', () => {
        process.env = {
            NODE_ENV: 'production',
            PORT: '8080',
            DATABASE_URL: 'postgres://prod:pass@db:5432/prod_db',
            REDIS_URL: 'redis://redis:6379',
            LOG_LEVEL: 'error',
            WORKER_COUNT: '4',
            SHUTDOWN_TIMEOUT_MS: '5000',
        };

        const { config } = require('./env');

        expect(config.NODE_ENV).toBe('production');
        expect(config.PORT).toBe(8080);
        expect(config.DATABASE_URL).toBe('postgres://prod:pass@db:5432/prod_db');
        expect(config.REDIS_URL).toBe('redis://redis:6379');
        expect(config.LOG_LEVEL).toBe('error');
        expect(config.WORKER_COUNT).toBe(4);
        expect(config.SHUTDOWN_TIMEOUT_MS).toBe(5000);

        expect(process.exit).not.toHaveBeenCalled();
    });

    it('should call process.exit(1) and console.error if DATABASE_URL is missing', () => {
        process.env = {
            NODE_ENV: 'test',
            REDIS_URL: 'redis://localhost:6379'
        };
        delete process.env.DATABASE_URL;

        require('./env');

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"DATABASE_URL" is required'));
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should call process.exit(1) and console.error if REDIS_URL is missing', () => {
        process.env = {
            NODE_ENV: 'test',
            DATABASE_URL: 'postgres://user:pass@localhost:5432/db'
        };
        delete process.env.REDIS_URL;

        require('./env');

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"REDIS_URL" is required'));
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should call process.exit(1) if invalid URI is provided for database', () => {
        process.env = {
            DATABASE_URL: 'invalid-uri',
            REDIS_URL: 'redis://localhost:6379',
        };

        require('./env');

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"DATABASE_URL" must be a valid uri'));
        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should export a frozen config object', () => {
        process.env = {
            DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
            REDIS_URL: 'redis://localhost:6379',
        };

        const { config } = require('./env');

        expect(Object.isFrozen(config)).toBe(true);
        expect(() => {
            (config as any).PORT = 9999;
        }).toThrow();
    });
});
