import cluster from 'cluster';
import os from 'os';
import { ClusterManager } from './clusterManager';

jest.mock('cluster', () => {
    return {
        isPrimary: true,
        fork: jest.fn(() => ({ process: { pid: 123 } })),
        on: jest.fn(),
        workers: {}
    };
});

jest.mock('os', () => ({
    cpus: jest.fn(() => [1, 2, 3, 4])
}));

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn()
    });
});

describe('ClusterManager', () => {
    let originalExit: any;
    
    beforeEach(() => {
        jest.clearAllMocks();
        
        originalExit = process.exit;
        process.exit = jest.fn() as any;
        
        // Mock process.on to capture signal handlers
        process.on = jest.fn() as any;
    });

    afterEach(() => {
        process.exit = originalExit;
    });

    it('should initialize and fork workers based on config', () => {
        const config: any = { WORKER_COUNT: 2 };
        const manager = new ClusterManager(config);

        manager.start();

        expect(cluster.fork).toHaveBeenCalledTimes(2);
        expect(cluster.on).toHaveBeenCalledWith('exit', expect.any(Function));
    });

    it('should default to os.cpus().length if WORKER_COUNT is missing', () => {
        const config: any = {};
        const manager = new ClusterManager(config);

        manager.start();

        expect(cluster.fork).toHaveBeenCalledTimes(4); // from mocked os.cpus
    });

    it('should not fork if not primary', () => {
        (cluster as any).isPrimary = false;
        const manager = new ClusterManager({ WORKER_COUNT: 2 } as any);

        manager.start();

        expect(cluster.fork).not.toHaveBeenCalled();
        (cluster as any).isPrimary = true;
    });

    it('should exit when fork bomb detected', () => {
        const manager = new ClusterManager({ WORKER_COUNT: 1 } as any);
        
        // Force the forkHistory to simulate a bomb (workerCount + 5 = 6 forks)
        (manager as any).forkHistory = [
            Date.now(),
            Date.now(),
            Date.now(),
            Date.now(),
            Date.now(),
            Date.now()
        ];

        (manager as any).forkWorker();

        expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should handle worker exit and fork another worker', () => {
        const manager = new ClusterManager({ WORKER_COUNT: 1 } as any);
        manager.start();
        
        const exitHandler = (cluster.on as jest.Mock).mock.calls.find(call => call[0] === 'exit')[1];

        // Reset fork counts from start
        (cluster.fork as jest.Mock).mockClear();
        
        exitHandler({ process: { pid: 123 } }, 1, null);
        
        expect(cluster.fork).toHaveBeenCalledTimes(1);
    });

    it('should handle SIGTERM and shutdown gracefully', async () => {
        const manager = new ClusterManager({ WORKER_COUNT: 1, SHUTDOWN_TIMEOUT_MS: 10 } as any);
        manager.start();

        const sigtermHandler = (process.on as jest.Mock).mock.calls.find(call => call[0] === 'SIGTERM')[1];

        // Mock workers
        const mockSend = jest.fn();
        (cluster.workers as any) = {
            '1': { send: mockSend }
        };

        await sigtermHandler();

        expect(mockSend).toHaveBeenCalledWith({ type: 'SHUTDOWN' });

        // wait for timeout
        await new Promise(resolve => setTimeout(resolve, 20));
        
        expect(process.exit).toHaveBeenCalledWith(0);
    });
});
