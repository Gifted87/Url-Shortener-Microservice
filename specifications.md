# URL Shortener Microservice: Complete Technical Specifications

## 1. Document Purpose and Architectural Vision

This specifications document provides an exhaustive, definitive blueprint of the URL Shortener Microservice. This is not merely a user guide; it is a structural, algorithmic, and architectural deep dive intended for Senior Engineers, Site Reliability Engineers (SREs), and Software Architects. 

The microservice is engineered to achieve three conflicting requirements:
1. **Ultra-Low Latency:** Redirects must happen in single-digit milliseconds.
2. **High Throughput:** The system must withstand sudden, viral spikes in traffic without degrading.
3. **Data Integrity & Telemetry:** Every click must be tracked, and URL aliases must never collide, all while maintaining strict compliance with HTTP semantics.

To achieve this, the architecture embraces strict separation of concerns, heavily leverages read-through caching, offloads synchronous write operations to asynchronous message queues, and implements clustered processing to bypass Node.js's single-threaded limitations.

## 2. Directory Structure and Modularity

The application adheres to a modular monolith design pattern within the `src` directory.

- `src/bootstrap`: System initialization, cluster orchestration, and graceful degradation.
- `src/config`: Strongly typed environment variable parsing and validation.
- `src/database`: Persistence and caching abstractions (PostgreSQL, Redis).
- `src/middleware`: HTTP request interception, rate limiting, and sanitization.
- `src/routes`: API boundary definition and HTTP status management.
- `src/services`: The domain-driven core business logic.
- `src/utils`: Pure, side-effect-free cryptographic and mathematical utilities.
- `src/validation`: Joi-based schema definitions to protect the system boundary.
- `src/workers`: Out-of-band daemon processes for eventual consistency.

## 3. Subsystem Specification: The Bootstrap Layer

The `bootstrap` module is a defensive perimeter designed to ensure the application never boots into an unstable state and never terminates without cleaning up its resources.

### 3.1. `src/bootstrap/cluster/clusterManager.ts`
**Specification:**
The Cluster Manager is responsible for vertical scaling on the host machine. It intercepts the Node.js `cluster` API to spawn worker processes equal to `os.cpus().length` or the `WORKER_COUNT` environment variable.

**Algorithmic Defense (Fork-Bomb Prevention):**
A naive cluster manager will constantly restart a crashing worker. If a database is down, this creates an infinite loop that exhausts CPU and fills disk space with logs.
The `ClusterManager` maintains an array of timestamps (`forkHistory`). Before calling `cluster.fork()`, it purges timestamps older than `FORK_WINDOW_MS` (60,000ms). If the length of the remaining array exceeds `FORK_THRESHOLD` (5), the manager categorizes the state as a "fork bomb", logs a fatal error, and forcefully exits the master process (`process.exit(1)`).

### 3.2. `src/bootstrap/lifecycle/shutdown.ts`
**Specification:**
This module intercepts the `SIGTERM` and `SIGINT` IPC signals originating from the host OS or orchestrator (e.g., Kubernetes). 

**Execution Flow:**
1. Intercept signal.
2. Send a `SHUTDOWN` message to all `cluster.workers`.
3. Workers invoke `server.close()` to stop accepting new TCP connections.
4. Existing HTTP requests are allowed to complete naturally.
5. The `AnalyticsFlushWorker` is triggered to perform one final, synchronous flush of the Redis buffer to PostgreSQL.
6. The `RedisClient` issues a `QUIT` command.
7. The PostgreSQL `Pool` is ended.
8. The process exits with code `0`.

If this sequence takes longer than `SHUTDOWN_TIMEOUT_MS`, a `setTimeout` forcefully kills the process with code `1` to prevent deployment hangs.

### 3.3. `src/bootstrap/main/server.ts`
**Specification:**
The Express server factory. It is explicitly responsible for applying global middleware in a specific, non-negotiable order:
1. `helmetMiddleware`: Applied first to secure headers before any body parsing occurs.
2. `express.json({ limit: '1mb' })`: Applied second. The 1MB limit is a hard requirement to prevent `Memory Denial of Service` via massive payloads.
3. `requestSanitizationMiddleware`: Applied third, only after the body is parsed into a JSON object.
4. `rateLimiter`: Applied fourth.
5. `API Routers`: Applied last.

## 4. Subsystem Specification: Database and Caching

### 4.1. `src/database/redis/redisClient.ts`
**Specification:**
The raw `ioredis` library is too permissive. This module implements a Singleton Wrapper Pattern.
- **Connection Resilience:** Implements an exponential backoff function: `Math.min(times * 50, 2000)`. This guarantees that transient network partitions do not crash the application, but instead trigger silent reconnection attempts capped at a 2-second delay.
- **Pipeline Implementation:** Exposes a strongly typed `pipeline()` method. This is mandatory for operations that require atomicity, such as the rate limiter (which must `INCR` and `EXPIRE` simultaneously) or the analytics worker (which must pop a batch of items simultaneously).

### 4.2. Relational Schema Definition (PostgreSQL)
The state of the system is governed by two heavily indexed tables.

**Table: `urls`**
- `id (BIGSERIAL)`: Primary Key. Used mathematically for Base62 encoding.
- `alias (VARCHAR(16))`: Unique constraint. Indexed via B-Tree.
- `original_url (TEXT)`: The un-encoded destination.
- `owner_id (VARCHAR(64))`: Optional tenant identifier, indexed via B-Tree for rapid tenant lookups.

**Table: `clicks`**
- `id (BIGSERIAL)`: Primary Key.
- `url_id (BIGINT)`: Foreign Key referencing `urls(id) ON DELETE CASCADE`.
- `timestamp (TIMESTAMP WITH TIME ZONE)`: The exact moment of the redirect.
- `ip_address (INET)`: Stored efficiently using Postgres native networking types.
- `user_agent (VARCHAR(512))`
- `referer (VARCHAR(512))`
- **Composite Index:** `(url_id, timestamp)`. This is the most critical index in the system, specifically designed to accelerate time-series analytical dashboards.

## 5. Subsystem Specification: Middleware Interceptors

### 5.1. `src/middleware/rate_limiter/index.ts`
**Specification:**
A distributed Fixed Window rate limiter that operates entirely within the Redis cache layer.

**Logic Matrix:**
1. Extract `req.ip`.
2. Construct key: `ratelimit:{ip}`.
3. Execute `Redis Pipeline`: `['incr', key]`, `['ttl', key]`.
4. If the incremented value is exactly `1`, this is a new window. Execute `redis.set(key, 1, 'EX', 60)`.
5. Calculate remaining quota: `Math.max(0, LIMIT - currentCount)`.
6. Attach Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`.
7. If `currentCount > LIMIT`, return `429 Too Many Requests`.

**Fail-Open Requirement:**
If the `redis.pipeline()` throws a network exception, the `catch` block MUST invoke `next()` without returning an error to the client. Rate limiting is a secondary concern; primary redirection functionality takes absolute precedence.

### 5.2. `src/middleware/security/securityMiddleware.ts`
**Specification:**
Implements deep object traversal to neutralize injection vectors. The `requestSanitizationMiddleware` recursively maps over the keys of `req.body`, `req.query`, and `req.params`. If a value is a string, it executes `replace(/[<>]/g, '')` to strip potential HTML/script tags. This mitigates Stored XSS if the payload is later rendered in a dashboard.

## 6. Subsystem Specification: Domain Services

### 6.1. `src/services/url/urlService.ts`
**Specification:**
The absolute source of truth for URL manipulation.

**Shortening Algorithm (Write Path):**
1. Open Postgres `PoolClient`.
2. Execute `BEGIN`.
3. Insert a dummy string into `urls` to trigger the `BIGSERIAL` sequence. `RETURNING id`.
4. Pass the returned `id` to `generateAlias(id)`.
5. Execute `UPDATE urls SET alias = $1 WHERE id = $2`.
6. Execute `COMMIT`.
7. Execute `redis.set(alias, original_url, 86400)`.

**Resolution Algorithm (Read Path):**
1. Interrogate Redis `get(alias)`. Return immediately if hit.
2. Interrogate Postgres `SELECT original_url FROM urls WHERE alias = $1`.
3. If row exists, populate Redis `set(alias, original_url, 86400)`.
4. Return `original_url` or `null`.

### 6.2. `src/services/analytics/analyticsService.ts`
**Specification:**
A non-blocking telemetry ingestor.

**Ingestion Flow:**
1. Validate `isIP(ip)`.
2. Check `redis.llen('analytics:buffer')`. If >= 10000, abort and drop telemetry (Backpressure protection).
3. Execute `redis.hincrby(metrics:clicks:{urlId}, total, 1)`.
4. Construct unique fingerprint: `${ip}:${userAgent}`.
5. Execute `redis.sadd(metrics:visitors:{urlId}:{date}, fingerprint)`.
6. Stringify payload and execute `redis.rpush('analytics:buffer', payload)`.

## 7. Subsystem Specification: Background Workers

### 7.1. `src/workers/analyticsFlushWorker.ts`
**Specification:**
A daemon designed to offload database writes from the HTTP event loop, providing eventual consistency.

**Batching Algorithm:**
1. Awaken every 5000ms.
2. Execute `redis.pipeline()` to pop up to 500 items via `LPOP`.
3. Iterate and `JSON.parse()` items.
4. Execute `BEGIN` on Postgres.
5. Execute 500 parameterized `INSERT` statements.
6. Execute `COMMIT`.

**Failure Recovery:**
If the `COMMIT` fails due to a deadlock, constraint violation, or network timeout, the `catch` block executes `ROLLBACK`. Crucially, it then iterates over the raw string payloads and executes `redis.rpush('analytics:buffer', raw)` to return the events to the queue for the next cycle.

## 8. Subsystem Specification: Validation and Utilities

### 8.1. `src/validation/urlValidation.ts`
**Specification:**
Employs `joi` to establish a strict boundary contract.
- `original_url`: Must pass Joi's internal URI regex parser enforcing `http` or `https` schemes.
- `stripUnknown`: The schema compilation explicitly uses `stripUnknown: true`. This prevents Mass Assignment (e.g., a user attempting to inject `"id": 1` or `"is_admin": true` into the payload).
- **Error Formatting:** If validation fails, the middleware maps over `error.details`, constructs a JSON array of `field` and `message` properties, and returns a `400` status.

### 8.2. `src/utils/hashing/aliasGenerator.ts`
**Specification:**
The mathematical engine of the system.
- `BASE62_CHARSET`: `0-9a-zA-Z`.
- **Encoding:** A `while (id > 0n)` loop calculates `id % 62`, prepends the corresponding character from the charset string, and divides `id` by `62`. This is performed using JavaScript's native `BigInt` to prevent floating-point precision loss on massive IDs.
- **Decoding:** Iterates over the string, finding the index of each character in the charset, and multiplying the running total by 62 before adding the index. This allows the system to reverse-engineer the database ID directly from the alias without executing a SQL query.

## 9. Operational and Deployment Specifications

### 9.1. Containerization Standards
The application must be packaged using a multi-stage Dockerfile. 
- Stage 1 compiles the TypeScript (`tsc`) into pure JavaScript.
- Stage 2 copies only the `dist` folder and `package.json`, runs `npm install --production` to omit devDependencies, and executes `node dist/index.js`. This drastically reduces the image size and attack surface.

### 9.2. Scaling Topology
- **Compute:** The Node.js application is strictly stateless. It can be horizontally scaled infinitely behind an AWS Application Load Balancer or Kubernetes Ingress.
- **Cache:** The Redis cluster is stateful but ephemeral. If scaled horizontally, the application must be configured to connect to the Redis cluster endpoint, allowing `ioredis` to manage node discovery.
- **Database:** PostgreSQL handles pure persistence. Read replicas can be provisioned and connected to an internal BI/Analytics dashboard, ensuring that heavy analytical queries do not lock tables required by the core URL shortening worker.
## 10. Data Structures and Payload Specifications

### 10.1. Request Payloads
The system exposes a strictly typed API. The following JSON schemas dictate the exact shape of incoming and outgoing data, ensuring the application acts as a secure boundary.

**ShortenRequestPayload (POST /api/v1/shorten)**
```json
{
  "original_url": {
    "type": "string",
    "format": "uri",
    "required": true,
    "description": "The destination URL. Must be a valid HTTP/HTTPS scheme to prevent javascript: or data: injection vectors."
  },
  "owner_id": {
    "type": "string",
    "maxLength": 64,
    "required": false,
    "description": "A unique tenant or user identifier. Useful for tracking URLs generated by specific authenticated users."
  }
}
```

### 10.2. Response Models

**ShortenSuccessResponse (200 OK)**
```json
{
  "alias": {
    "type": "string",
    "description": "The Base62 encoded database ID."
  },
  "short_url": {
    "type": "string",
    "description": "The fully qualified URL that clients will use to trigger a redirect."
  },
  "original_url": {
    "type": "string",
    "description": "The un-encoded destination."
  }
}
```

**ValidationErrorResponse (400 Bad Request)**
```json
{
  "status": 400,
  "message": "Validation failed",
  "errors": [
    {
      "field": "original_url",
      "message": "must be a valid uri with a scheme matching the http|https pattern"
    }
  ]
}
```

**RateLimitErrorResponse (429 Too Many Requests)**
```json
{
  "status": 429,
  "message": "Too Many Requests",
  "retry_after": 35
}
```

## 11. Error Handling and Status Code Specifications

The microservice strictly adheres to standard HTTP status codes, treating them as a universal contract with calling clients. 

### 11.1. Client Errors (4xx)
- **400 Bad Request:** Emitted exclusively by the `joi` validation middleware. It signifies that the payload is syntactically invalid or fails the cryptographic contract (e.g., malformed URIs, extraneous fields, incorrect data types). The response body always contains an array detailing the exact fields that failed validation, allowing clients to debug their requests instantly without checking server logs.
- **404 Not Found:** Emitted when the `UrlService.resolveUrl` method returns `null` because the alias exists neither in the Redis cache nor the PostgreSQL database. This is a normal operational state and does not trigger an `error`-level log, only an `info` log.
- **429 Too Many Requests:** Triggered by the `rateLimiter` middleware. It is essential to protect the system's availability. When this status is returned, the system halts processing immediately—the body is not parsed, validation is skipped, and no database connections are opened.

### 11.2. Server Errors (5xx)
- **500 Internal Server Error:** Indicates an unhandled exception or a critical infrastructure failure. For instance, if a PostgreSQL transaction fails during the insertion of a new URL and the rollback succeeds, the system must bubble up a 500 status code. The Express `next(err)` mechanism captures this. Crucially, the detailed stack trace is *never* returned to the client to prevent information leakage; instead, a generic "Internal Server Error" message is sent, while the full stack trace and request context are logged to `stdout` via Pino.
- **503 Service Unavailable:** Not actively emitted by the Node.js application, but anticipated from the ingress controller or load balancer if the application fails its liveness probes (e.g., if the fork-bomb detection algorithm shuts down the cluster).

## 12. Logging, Observability, and Telemetry Specifications

In a distributed environment, debugging via `console.log` is impossible. The application utilizes a highly structured, machine-readable observability strategy.

### 12.1. Structured Logging (Pino)
The system uses `pino` instead of `winston` or `console.log` because it performs asynchronous stringification and minimizes event loop blocking. 

**Log Level Definitions:**
- `FATAL (60)`: The system is completely broken and is shutting down immediately. Triggered by configuration failures (`env.ts`) or cluster-level crashes (`server.ts` failing to bind a port).
- `ERROR (50)`: A significant operation failed, but the system remains alive. Triggered by PostgreSQL transaction rollbacks or Redis connection drops.
- `WARN (40)`: Suspicious activity or degraded performance. Triggered by rate limit violations or invalid IP payloads.
- `INFO (30)`: Normal operational lifecycle events. Service starting, successful URL creation, successful batch flush.
- `DEBUG (20)`: Highly verbose routing data. Disabled in production by default.

**Log Schema Specification:**
Every log entry is a JSON object.
```json
{
  "level": "INFO",
  "time": "2023-10-27T10:00:00.000Z",
  "pid": 12345,
  "hostname": "worker-node-1",
  "msg": "URL shortened successfully",
  "alias": "7kF",
  "originalUrl": "https://example.com"
}
```
This strict schema allows log aggregators (Elasticsearch, Datadog) to instantly index the logs. SREs can filter by `alias="7kF"` to trace the complete lifecycle of a single URL across multiple servers.

### 12.2. Health Monitoring and Probes
Kubernetes demands dedicated endpoints to determine the routing status of a pod.

**GET /health**
- **Specification:** A lightweight, unauthenticated endpoint that bypasses all rate limiting and payload parsing.
- **Behavior:** It simply returns `200 OK` with a JSON payload: `{"status": "UP", "timestamp": "..."}`.
- **Architectural Function:** It serves as a liveness probe. If the Node.js event loop is blocked indefinitely by a synchronous CPU-bound operation (e.g., a massive regex execution), this endpoint will timeout. Kubernetes will interpret this timeout as a failure and kill the pod, triggering a self-healing restart cycle.

## 13. Architectural Trade-offs and Strategic Decisions

Engineering is the practice of balancing competing constraints. The architecture of this URL shortener involves several deliberate trade-offs to maximize throughput and reliability.

### 13.1. Two-Phase Insertion vs. Random String Generation
- **Alternative:** Generate a random 6-character string (`Math.random()`), check if it exists in the database, and if not, insert it. If it exists, retry.
- **Decision:** The system utilizes a two-phase insertion (insert placeholder, get auto-incremented ID, generate Base62 alias, update record).
- **Trade-off:** This requires opening a transaction and performing two queries (`INSERT` then `UPDATE`) per request. While this marginally increases write latency compared to a single insert, it mathematically eliminates collisions. The random string approach degrades exponentially as the database fills up, eventually leading to massive retry loops under load. The two-phase Base62 approach guarantees predictable $O(1)$ performance regardless of database size.

### 13.2. Asynchronous Buffering vs. Synchronous Analytics
- **Alternative:** Execute an `INSERT` into the `clicks` table immediately before sending the `302 Redirect` to the client.
- **Decision:** The system pushes analytics into a Redis `List` and returns the redirect instantly. A background worker (`AnalyticsFlushWorker`) pops events in batches of 500 and inserts them later.
- **Trade-off:** This trades strong consistency for eventual consistency. If the Redis cache abruptly crashes before the background worker flushes the buffer, those click events are permanently lost. However, this is an acceptable trade-off: the primary goal of the system is ultra-low latency redirection. Subjecting users to database I/O latency for telemetry is an anti-pattern. We sacrifice a tiny fraction of analytical accuracy to guarantee lightning-fast user experiences.

### 13.3. Fail-Open vs. Fail-Closed Rate Limiting
- **Alternative:** If the Redis connection drops, the rate limiter could throw a 500 error, blocking all incoming requests until Redis recovers.
- **Decision:** The system employs a fail-open strategy. If the `redis.pipeline()` fails, the rate limiter catches the error, logs a warning, and calls `next()`, allowing the request through.
- **Trade-off:** This temporarily exposes the system to abuse during a caching outage. However, failing closed would mean a Redis failure instantly takes down the entire routing capability of the microservice. The decision prioritizes core system availability (URL resolution) over auxiliary protection.

### 13.4. Multi-Process Clustering vs. Thread Pools
- **Alternative:** Utilize Node.js `Worker Threads` to handle CPU-bound tasks.
- **Decision:** The system uses the native `cluster` module to fork completely separate V8 isolate processes (`clusterManager.ts`).
- **Trade-off:** Forking processes consumes significantly more memory than lightweight threads, as each process spins up its own V8 engine and event loop. However, since Express and HTTP routing are inherently bound to the main event loop, Worker Threads do not help parallelize network I/O. By forking full processes, the application scales horizontally across all CPU cores, allowing the OS kernel to load balance incoming TCP connections efficiently via the master process.

## 14. Performance Benchmarks and Scaling Limits

The architecture is designed to handle immense load, but specific chokepoints dictate how it must be scaled.

### 14.1. CPU Bound Limitations (Node.js)
Node.js excels at network I/O but struggles with CPU-bound synchronous operations. The Base62 generator (`aliasGenerator.ts`) utilizes `BigInt` math. While highly optimized, if an attacker spams the `POST /shorten` endpoint, the CPU must compute thousands of divisions and modulo operations per second.
- **Scaling Solution:** Horizontal scaling of the Express pods behind an Application Load Balancer. Since state is completely offloaded to Redis and Postgres, adding more pods linearly increases the CPU computation capacity.

### 14.2. Memory Bound Limitations (Redis)
The application relies heavily on Redis for both read-through caching (`url:*`) and analytical buffering (`analytics:buffer`).
- **Scaling Limit:** If viral links generate millions of clicks, the `analytics:buffer` will grow rapidly. The `MAX_BUFFER_SIZE` logic prevents the Node.js application from exhausting its own RAM, but Redis itself can OOM if the TTLs are configured incorrectly.
- **Scaling Solution:** Implement Redis clustering or utilize a managed service (AWS ElastiCache). Ensure the eviction policy is strictly set to `volatile-lru` so that only keys with TTLs (cached URLs) are evicted, protecting the analytics queue.

### 14.3. I/O Bound Limitations (PostgreSQL)
The primary bottleneck for URL shortening is database connection limits and transaction locks. The two-phase insertion requires transaction overhead.
- **Scaling Limit:** If 10,000 requests hit the system simultaneously, attempting to open 10,000 direct database connections will exhaust the connection pool and trigger `ECONNREFUSED` errors.
- **Scaling Solution:** The application utilizes the `pg.Pool` internally. For massive scale, an external connection pooler like `PgBouncer` is required to multiplex millions of application connections onto a smaller number of physical PostgreSQL connections, dramatically reducing transaction latency and memory overhead on the database server.

## 15. Summary

This technical specification delineates a highly fault-tolerant, resilient, and performant URL Shortener architecture. By combining a mathematically deterministic Base62 encoding strategy with distributed Redis pipelines, fail-open security middlewares, and asynchronous telemetry batching, the microservice is prepared for enterprise-scale deployments. The strict modularity of the `src` directory ensures that as business requirements evolve, the core redirection engine remains pristine, testable, and secure.
