import { ClusterManager } from './bootstrap/cluster/clusterManager';
import { config } from './config/env';
import cluster from 'cluster';

// If clustering is enabled, start the cluster manager.
// Otherwise, or if we are a worker, boot the actual HTTP server.
if (cluster.isPrimary && (config.WORKER_COUNT || 1) > 1) {
    const manager = new ClusterManager(config);
    manager.start();
} else {
    // Import the server bootstrap, which self-executes
    const { startServer } = require('./bootstrap/main/server');
    startServer();
}
