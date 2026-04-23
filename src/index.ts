import { ClusterManager } from './bootstrap/cluster/clusterManager';
import { config } from './config/env';
import cluster from 'cluster';
import { AnalyticsFlushWorker } from './workers/analyticsFlushWorker';
import { pool } from './database/postgres/pool';
import { redis } from './database/redis/redisClient';

/**
 * Entry point for the URL Shortener Microservice.
 * Orchestrates clustering and background worker lifecycle.
 */
if (cluster.isPrimary) {
    const workerCount = config.WORKER_COUNT || 1;
    
    // 1. Initialize Analytics Background Worker (Singleton in Primary)
    const analyticsWorker = new AnalyticsFlushWorker(pool, redis);
    analyticsWorker.start();
    
    // 2. Start Cluster Manager if multi-core is requested
    if (workerCount > 1) {
        const manager = new ClusterManager(config, analyticsWorker);
        manager.start();
    } else {
        // Single process mode: handle local shutdown for the worker
        const { startServer } = require('./bootstrap/main/server');
        startServer();

        const gracefulShutdown = async () => {
            await analyticsWorker.stop();
            process.exit(0);
        };
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
    }
} else {
    // Worker process: Boot the actual HTTP server
    const { startServer } = require('./bootstrap/main/server');
    startServer();
}

