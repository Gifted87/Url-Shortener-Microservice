import { Server } from 'http';
import { Pool } from 'pg';
import { redis } from '../../database/redis/redisClient';
import { analyticsService } from '../../services/analytics/analyticsService';
import { ShutdownManager } from './shutdown';

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        fatal: jest.fn()
    });
});

jest.mock('../../database/redis/redisClient', () => ({
    redis: {
        quit: jest.fn()
    }
}));

jest.mock('../../services/analytics/analyticsService', () => ({
    analyticsService: {
        processBufferedClicks: jest.fn()
    }
}));

describe('ShutdownManager', () => {
    let server: jest.Mocked<Server>;
    let pgPool: jest.Mocked<Pool>;
    let originalExit: any;

    beforeEach(() => {
        jest.clearAllMocks();
        
        server = {
            close: jest.fn()
        } as unknown as jest.Mocked<Server>;

        pgPool = {
            end: jest.fn()
        } as unknown as jest.Mocked<Pool>;

        originalExit = process.exit;
        process.exit = jest.fn() as any;
        process.on = jest.fn() as any;
    });

    afterEach(() => {
        process.exit = originalExit;
    });

    it('should register signal handlers on initialize', () => {
        const manager = new ShutdownManager(server, pgPool);
        manager.initialize();

        expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });

    it('should complete graceful shutdown successfully', async () => {
        const manager = new ShutdownManager(server, pgPool);
        manager.initialize();

        const sigtermHandler = (process.on as jest.Mock).mock.calls.find(call => call[0] === 'SIGTERM')[1];

        // Mock successful server close
        (server.close as jest.Mock).mockImplementation((cb: Function) => cb());
        
        // Mock DB and Redis close
        (pgPool.end as jest.Mock).mockResolvedValue(true);
        (redis as any).quit.mockResolvedValue('OK');

        await sigtermHandler();

        expect(server.close).toHaveBeenCalled();
        expect(pgPool.end).toHaveBeenCalled();
        expect((redis as any).quit).toHaveBeenCalled();
        expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should exit with 1 if server close throws error', async () => {
        const manager = new ShutdownManager(server, pgPool);
        
        // Mock failed server close
        (server.close as jest.Mock).mockImplementation((cb: Function) => cb(new Error('Server close error')));
        
        await (manager as any).handleSignal('SIGTERM');

        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should handle timeout during server close', async () => {
        // Mock SHUTDOWN_TIMEOUT_MS by overriding it before the test or instantiating with small delay
        const mockServer: any = {
            close: jest.fn() // never calls cb to simulate timeout
        };
        const manager = new ShutdownManager(mockServer, pgPool);
        (manager as any).SHUTDOWN_TIMEOUT_MS = 10;

        await (manager as any).handleSignal('SIGTERM');

        expect(process.exit).toHaveBeenCalledWith(1);
    });
});
