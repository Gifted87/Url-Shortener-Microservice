# Architecture Breakdown

## Root Directory
- `src`: Main source directory containing all application logic.

### High-level Modules in `src`
- `bootstrap`: Contains initialization logic for the application, such as clustering, graceful shutdown, health checks, and server setup.
- `config`: Configuration management.
- `database`: Database connection and query logic.
- `middleware`: Express middlewares.
- `routes`: Express route handlers.
- `services`: Core business logic services.
- `utils`: Utility functions and helpers.
- `validation`: Input validation logic.
- `workers`: Background workers or job processing logic.

---

## File Level Breakdown

### Module: `config`
- `src/config/env.ts`
  - **Purpose**: Uses `dotenv` and `joi` to define, load, and strictly validate environment variables. Fails fast if configuration is invalid.
  - **Architectural Contribution**: Acts as the single source of truth for configuration across the entire microservice, providing a typed, frozen configuration object (`AppConfig`).

### Module: `bootstrap`
- **Submodules**:
  - `cluster`: Clustering and concurrency management.
  - `lifecycle`: Process lifecycle (shutdown).
  - `main`: Server initialization.
  - `health`: Health checks.

- `src/bootstrap/cluster/clusterManager.ts`
  - **Purpose**: Manages multi-process orchestration using Node.js's native `cluster` module. Detects fork bombs and restarts workers.
  - **Architectural Contribution**: Provides high availability, concurrency, and self-healing at the process level.

- `src/bootstrap/lifecycle/shutdown.ts`
  - **Purpose**: Orchestrates graceful termination, stopping HTTP traffic, flushing analytics, and closing database/Redis connections.
  - **Architectural Contribution**: Prevents data loss and ensures resources are cleanly decommissioned during deployment or scaling.

- `src/bootstrap/main/server.ts`
  - **Purpose**: Centralized server bootstrap entry point. Injects middlewares, sets up routing, and starts the Express HTTP server.
  - **Architectural Contribution**: Binds the application logic to the network interface securely and reliably.

- `src/bootstrap/health/healthMonitor.ts` & `src/bootstrap/health/health.ts`
  - **Purpose**: Exposes endpoints and internal methods to check database and cache connectivity.
  - **Architectural Contribution**: Provides liveness and readiness probes for orchestrators like Kubernetes.

### Module: `database`
- **Submodules**:
  - `redis`: Redis cache connection.

- `src/database/redis/redisClient.ts`
  - **Purpose**: Wraps `ioredis` to manage connection, auto-retry, and provides structured access methods (get, set, sadd, lpop, etc).
  - **Architectural Contribution**: Acts as the application's fast data store for analytics buffering and rate limiting.

### Module: `services`
- **Submodules**:
  - `analytics`: Tracks click telemetry.
  - `url`: Handles short URL logic.

- `src/services/analytics/analyticsService.ts`
  - **Purpose**: Buffers incoming clicks into a Redis list, periodically flushing them in batches to the database.
  - **Architectural Contribution**: Decouples read telemetry from write operations, allowing high throughput click tracking without overloading PostgreSQL.

- `src/services/url/urlService.ts`
  - **Purpose**: Contains the core business logic for generating short aliases, storing them in PostgreSQL, caching them in Redis, and tracking access.
  - **Architectural Contribution**: The central orchestration point for the URL shortening domain logic.

### Module: `middleware`
- **Submodules**:
  - `rate_limiter`: Request throttling.
  - `security`: Helmet and sanitization.

- `src/middleware/rate_limiter/index.ts`
  - **Purpose**: Implements a sliding window rate limiter backed by Redis using Lua scripts.
  - **Architectural Contribution**: Protects the API from DDoS attacks and abuse.

- `src/middleware/security/securityMiddleware.ts`
  - **Purpose**: Configures HTTP headers using `helmet` and sanitizes incoming payloads.
  - **Architectural Contribution**: Secures the application against common web vulnerabilities (XSS, Clickjacking).

### Module: `routes`
- `src/routes/shortener.ts`
  - **Purpose**: Maps HTTP endpoints (`POST /api/v1/shorten`, `GET /:alias`) to the `urlService` and `validation` layers.
  - **Architectural Contribution**: Defines the RESTful API contract for the microservice.

### Module: `utils`
- **Submodules**:
  - `hashing`: Cryptographic operations.

- `src/utils/hashing/aliasGenerator.ts`
  - **Purpose**: Generates a cryptographically secure pseudo-random string for short URL aliases using `crypto` and Base62 encoding.
  - **Architectural Contribution**: Ensures collision-resistant, short, and URL-safe identifiers.

### Module: `validation`
- `src/validation/urlValidation.ts`
  - **Purpose**: Validates incoming URL payloads using `joi`.
  - **Architectural Contribution**: Rejects malformed requests before they hit business logic or database layers.

### Module: `workers`
- `src/workers/analyticsFlushWorker.ts`
  - **Purpose**: A standalone daemon/interval that triggers the `analyticsService` to flush buffered metrics from Redis to PostgreSQL.
  - **Architectural Contribution**: Ensures eventual consistency of analytics data without blocking HTTP request threads.
