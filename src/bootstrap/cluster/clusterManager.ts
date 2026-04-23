import cluster, { Worker } from 'cluster';
import os from 'os';
import pino from 'pino';
import { AppConfig } from '../../config/env';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface WorkerLifecycleEvent {
  type: 'SHUTDOWN' | 'HEALTH_CHECK';
}

/**
 * ClusterManager handles multi-process orchestration, health monitoring,
 * and graceful shutdown for the URL shortener microservice.
 */
export class ClusterManager {
  private readonly config: AppConfig;
  private readonly workerCount: number;
  private readonly forkHistory: number[] = [];
  private FORK_THRESHOLD: number = 5;
  private readonly FORK_WINDOW_MS = 60000;
  private readonly analyticsWorker?: any;
  private isShuttingDown = false;

  constructor(config: AppConfig, analyticsWorker?: any) {
    this.config = config;
    this.analyticsWorker = analyticsWorker;
    
    // Safety check for containerized environments:
    // 1. Prioritize explicit environment variable
    // 2. Use availableParallelism() if available (Node 19.4+)
    // 3. Default to 1 to prevent OOM in restricted containers
    let cores = 1;
    try {
      if (typeof os.availableParallelism === 'function') {
        cores = os.availableParallelism();
      } else {
        cores = os.cpus().length;
      }
    } catch (e) {
      cores = 1;
    }
    
    this.workerCount = config.WORKER_COUNT || cores;
    
    // Limit to a reasonable maximum for Node clustering in containers if not specified
    if (!config.WORKER_COUNT && this.workerCount > 4) {
      this.workerCount = 4;
    }
    
    // Dynamically adjust threshold to allow initial burst
    this.FORK_THRESHOLD = this.workerCount + 5;
  }


  /**
   * Orchestrates the spawning of worker processes.
   */
  public start(): void {
    if (!cluster.isPrimary) {
      return;
    }

    logger.info({ workerCount: this.workerCount }, 'Initializing cluster master');

    for (let i = 0; i < this.workerCount; i++) {
      this.forkWorker();
    }

    cluster.on('exit', (worker, code, signal) => {
      this.handleWorkerExit(worker, code, signal);
    });

    process.on('SIGTERM', () => this.handleSignal('SIGTERM'));
    process.on('SIGINT', () => this.handleSignal('SIGINT'));
  }

  private forkWorker(): void {
    if (this.isShuttingDown) return;

    if (this.isForkBombing()) {
      logger.fatal('Critical error: Fork-bomb detected. Entering backoff state.');
      process.exit(1);
    }

    this.forkHistory.push(Date.now());
    const worker = cluster.fork();
    logger.info({ pid: worker.process.pid }, 'Spawned new worker process');
  }

  private isForkBombing(): boolean {
    const now = Date.now();
    while (this.forkHistory.length > 0 && this.forkHistory[0] < now - this.FORK_WINDOW_MS) {
      this.forkHistory.shift();
    }
    return this.forkHistory.length >= this.FORK_THRESHOLD;
  }

  private handleWorkerExit(worker: Worker, code: number, signal: string | null): void {
    logger.error({ pid: worker.process.pid, code, signal }, 'Worker process exited');
    if (!this.isShuttingDown) {
      this.forkWorker();
    }
  }

  private async handleSignal(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info({ signal }, 'Graceful shutdown initiated');

    // Inform workers to initiate drainage
    const message: WorkerLifecycleEvent = { type: 'SHUTDOWN' };
    for (const id in cluster.workers) {
      cluster.workers[id]?.send(message);
    }

    // Stop analytics worker if running on primary
    if (this.analyticsWorker) {
      try {
        await this.analyticsWorker.stop();
        logger.info('Analytics worker stopped successfully on primary');
      } catch (err) {
        logger.error({ err }, 'Error stopping analytics worker on primary');
      }
    }

    // Wait for the configured timeout to allow workers to exit cleanly
    setTimeout(() => {
      logger.info('Shutdown timeout reached. Forcing primary exit.');
      process.exit(0);
    }, this.config.SHUTDOWN_TIMEOUT_MS);
  }
}
