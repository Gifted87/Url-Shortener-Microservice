const { Pool } = require('pg');

/**
 * Production-ready PostgreSQL connection pool manager.
 * Implements singleton pattern, retry logic for transient errors,
 * transaction support, and automated schema migration.
 */
class PoolManager {
    constructor() {
        if (PoolManager.instance) {
            return PoolManager.instance;
        }

        // Configuration sourced from environment variables
        const config = {
            connectionString: process.env.DATABASE_URL,
            min: parseInt(process.env.DB_POOL_MIN || '5', 10),
            max: parseInt(process.env.DB_POOL_MAX || '20', 10),
            idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
            connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT || '5000', 10),
        };

        if (!config.connectionString) {
            throw new Error('DATABASE_URL environment variable is not defined.');
        }

        this.pool = new Pool(config);

        this.pool.on('error', (err) => {
            console.error('Unexpected error on idle PostgreSQL client:', err);
        });

        this.pool.on('connect', () => {
            console.info('PostgreSQL connection pool established.');
        });

        PoolManager.instance = this;
    }

    /**
     * Executes a query with a retry strategy for transient database errors.
     * @param {string} text - SQL query string
     * @param {Array} [params] - Parameterized query values
     * @param {number} [retries=3] - Number of remaining retries
     * @returns {Promise<import('pg').QueryResult>}
     */
    async query(text, params = [], retries = 3) {
        try {
            return await this.pool.query(text, params);
        } catch (error) {
            if (this.isTransientError(error) && retries > 0) {
                const delay = Math.pow(2, 4 - retries) * 100;
                console.warn(`Transient error detected, retrying in ${delay}ms... (Remaining: ${retries - 1})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                return this.query(text, params, retries - 1);
            }
            throw error;
        }
    }

    /**
     * Determines if a database error is transient and worthy of retry.
     * @param {Error & {code?: string}} err 
     * @returns {boolean}
     */
    isTransientError(err) {
        // 57P01: admin_shutdown, 57P03: cannot_connect_now, 08006: connection_failure,
        // 08001: sqlclient_unable_to_establish_sqlconnection, 08004: sqlserver_rejected_establishment_of_sqlconnection
        const transientCodes = ['57P01', '57P03', '08006', '08001', '08004'];
        return transientCodes.includes(err.code);
    }

    /**
     * Executes a series of operations within a single database transaction.
     * @param {Function} callback - Async function receiving a client connection
     * @returns {Promise<any>}
     */
    async runTransaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    /**
     * Executes database schema migrations to ensure environment readiness.
     */
    async migrate() {
        const migrations = [
            `CREATE TABLE IF NOT EXISTS urls (
                id BIGSERIAL PRIMARY KEY,
                alias VARCHAR(255) UNIQUE NOT NULL,
                target_url TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );`,
            `CREATE TABLE IF NOT EXISTS clicks (
                id BIGSERIAL,
                url_id BIGINT REFERENCES urls(id),
                clicked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            ) PARTITION BY RANGE (clicked_at);`,
            `CREATE INDEX IF NOT EXISTS idx_urls_alias ON urls(alias);`
        ];

        for (const sql of migrations) {
            await this.query(sql);
        }
        console.info('Database migrations completed successfully.');
    }
}

module.exports = new PoolManager();
