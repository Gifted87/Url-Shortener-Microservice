/**
 * MigrationRunner: Production-grade schema migration service for URL Shortener.
 * Ensures database readiness with idempotent operations and partitioning.
 */

const { Pool } = require('pg');

class MigrationRunner {
    constructor(pool) {
        if (!process.env.DATABASE_URL) {
            throw new Error('FATAL: DATABASE_URL environment variable is not set.');
        }
        this.pool = pool;
        this.maxRetries = parseInt(process.env.DB_MIGRATION_RETRIES || '5', 10);
    }

    /**
     * Executes the full migration suite.
     * @returns {Promise<boolean>} Success status
     */
    async migrate() {
        console.info('Starting database migration...');
        try {
            // Use an advisory lock to prevent concurrent migrations
            await this.runWithLock(async () => {
                await this.createUrlsTable();
                await this.createClicksTable();
                await this.ensureMonthlyPartitions();
            });
            console.info('Database migration completed successfully.');
            return true;
        } catch (error) {
            console.error('Migration failed:', error);
            throw error;
        }
    }

    async runWithLock(callback) {
        const client = await this.pool.connect();
        try {
            // 12345678 is an arbitrary lock ID for this service
            await client.query('SELECT pg_advisory_xact_lock(12345678)');
            await callback(client);
        } finally {
            client.release();
        }
    }

    async createUrlsTable() {
        const sql = `
            CREATE TABLE IF NOT EXISTS urls (
                id BIGSERIAL PRIMARY KEY,
                alias VARCHAR(255) UNIQUE NOT NULL,
                original_url TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                owner_id VARCHAR(64) DEFAULT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_alias ON urls(alias);
        `;
        await this.executeWithRetry(sql);
    }

    async createClicksTable() {
        const sql = `
            CREATE TABLE IF NOT EXISTS clicks (
                id BIGSERIAL,
                url_id BIGINT NOT NULL,
                timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
                ip_address INET,
                user_agent TEXT,
                referer TEXT,
                PRIMARY KEY (id, timestamp),
                CONSTRAINT fk_url FOREIGN KEY(url_id) REFERENCES urls(id) ON DELETE CASCADE
            ) PARTITION BY RANGE (timestamp);
            CREATE INDEX IF NOT EXISTS idx_clicks_url_id_timestamp ON clicks (url_id, timestamp);
        `;
        await this.executeWithRetry(sql);
    }

    async ensureMonthlyPartitions() {
        const now = new Date();
        // Generate partitions for current month and next 6 months
        for (let i = 0; i < 7; i++) {
            const date = new Date(now.getFullYear(), now.getMonth() + i, 1);
            const nextDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
            
            const tableName = `clicks_y${date.getFullYear()}m${String(date.getMonth() + 1).padStart(2, '0')}`;
            const start = date.toISOString();
            const end = nextDate.toISOString();

            const sql = `
                CREATE TABLE IF NOT EXISTS ${tableName} PARTITION OF clicks
                FOR VALUES FROM ('${start}') TO ('${end}');
            `;
            await this.executeWithRetry(sql);
        }
    }

    async executeWithRetry(sql, retries = this.maxRetries) {
        try {
            await this.pool.query(sql);
        } catch (error) {
            if (this.isTransientError(error) && retries > 0) {
                const delay = Math.pow(2, this.maxRetries - retries) * 200;
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.executeWithRetry(sql, retries - 1);
            }
            throw error;
        }
    }

    isTransientError(err) {
        const transientCodes = ['57P01', '57P03', '08006', '08001', '08004', '40P01'];
        return transientCodes.includes(err.code);
    }
}

module.exports = MigrationRunner;
