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
  private readonly FORK_THRESHOLD = 5;
  private readonly FORK_WINDOW_MS = 60000;
  private isShuttingDown = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.workerCount = config.WORKER_COUNT || os.cpus().length;
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

    // Wait for the configured timeout to allow workers to exit cleanly
    setTimeout(() => {
      logger.info('Shutdown timeout reached. Forcing primary exit.');
      process.exit(0);
    }, this.config.SHUTDOWN_TIMEOUT_MS);
  }
}
