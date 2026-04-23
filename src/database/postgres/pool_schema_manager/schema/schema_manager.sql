-- Schema definition for URL Shortener Service
-- This script is idempotent and production-ready.

BEGIN;

-- 1. Create 'urls' table
-- Represents the core entity for URL mappings.
CREATE TABLE IF NOT EXISTS urls (
    id BIGSERIAL PRIMARY KEY,
    alias VARCHAR(255) NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    owner_id VARCHAR(64) DEFAULT NULL
);

-- Ensure UNIQUE constraint on alias for O(1)/O(log n) lookup performance
CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_alias ON urls(alias);

-- 2. Create 'clicks' table
-- Partitioned by range on 'timestamp' for high-performance time-series data management.
-- We include the partition key ('timestamp') in the PRIMARY KEY constraint.
CREATE TABLE IF NOT EXISTS clicks (
    id BIGSERIAL,
    url_id BIGINT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    referer TEXT,
    PRIMARY KEY (id, timestamp),
    CONSTRAINT fk_url
        FOREIGN KEY(url_id)
        REFERENCES urls(id)
        ON DELETE CASCADE
) PARTITION BY RANGE (timestamp);

-- 3. Partition Management
-- Create initial partitions for the next 12 months to ensure immediate operational readiness.
-- These are examples; production systems should have a background worker or cron job to 
-- automate partition creation.

CREATE TABLE IF NOT EXISTS clicks_y2026m04 PARTITION OF clicks
    FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m05 PARTITION OF clicks
    FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m06 PARTITION OF clicks
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m07 PARTITION OF clicks
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m08 PARTITION OF clicks
    FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m09 PARTITION OF clicks
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m10 PARTITION OF clicks
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m11 PARTITION OF clicks
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS clicks_y2026m12 PARTITION OF clicks
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- 4. Indices for analytical queries
-- Index on url_id and timestamp is essential for query patterns checking activity by specific URL.
CREATE INDEX IF NOT EXISTS idx_clicks_url_id_timestamp ON clicks (url_id, timestamp);

COMMIT;
