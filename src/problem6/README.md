# Problem 6: Scoreboard Module — Architecture Specification

## Overview

This document specifies the backend module responsible for maintaining a **live top-10 scoreboard**. Users earn score by completing actions on the website. Each completed action triggers an API call to update the user's score. The scoreboard reflects changes in near-real time.

---

## Requirements

1. Display the **top 10 users by score** on the scoreboard.
2. The scoreboard **updates live** when any score changes.
3. Users complete an action → client dispatches an API call to record the score increment.
4. **Prevent unauthorized score manipulation** — users must not be able to inflate their own or others' scores without going through a verified action.

---

## API Endpoints

### `POST /scores/increment`

Called by the client immediately after the user completes a verified action.

**Request**
```
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "action_id": "string"   // unique ID for the completed action (prevents replay)
}
```

**Response**
```json
{ "user_id": "u1", "new_score": 142 }
```

**Errors**
| Status | Reason |
|--------|--------|
| 401    | Missing or invalid JWT |
| 409    | `action_id` already consumed (replay attempt) |
| 422    | Action cannot be verified |

---

### `GET /scores/top`

Returns the current top-10 leaderboard. Public endpoint (no auth required).

**Response**
```json
{
  "scores": [
    { "rank": 1, "user_id": "u5", "username": "Bob", "score": 980 },
    ...
  ],
  "updated_at": "2026-05-21T03:00:00Z"
}
```

---

### `GET /scores/me`

Returns the authenticated user's current score and rank.

**Request**
```
Authorization: Bearer <JWT>
```

---

## Execution Flow

```
Client                   API Server              Redis                WebSocket Hub
  |                          |                     |                       |
  |-- POST /scores/increment |                     |                       |
  |   (JWT + action_id)      |                     |                       |
  |                          |-- Verify JWT        |                       |
  |                          |   extract user_id   |                       |
  |                          |                     |                       |
  |                          |-- SET NX consumed_action:<id> EX 86400 ---->|
  |                          |<-- OK / nil (409) --|                       |
  |                          |                     |                       |
  |                          |-- ZINCRBY leaderboard 10 <user_id> -------->|
  |                          |<-- new_score -------|                       |
  |                          |                     |                       |
  |<-- 200 { new_score } ----|                     |                       |
  |                          |                     |                       |
  |                          |-- ZREVRANGE leaderboard 0 9 WITHSCORES ---->|
  |                          |<-- top 10 entries --|                       |
  |                          |                     |                       |
  |                          |-- broadcast top 10 ----------------------->|
  |                          |                     |    (all WS clients)   |
  |<============================= WS push { type: "snapshot", scores } ===|
  |   (all connected clients)                                              |
```

---

## Data Model (Redis)

Redis is the primary store for live score data. It is purpose-built for sorted set operations and makes the top-N query O(log N + N) with no additional indexing.

| Key pattern                      | Type        | Purpose                                      |
|----------------------------------|-------------|----------------------------------------------|
| `leaderboard`                    | Sorted Set  | Members = `user_id`, scores = cumulative score. `ZINCRBY` on write, `ZREVRANGE … WITHSCORES` on read. |
| `user:<user_id>`                 | Hash        | Stores `username` for display in the leaderboard. |
| `consumed_action:<action_id>`    | String + TTL| Replay prevention. Set atomically with `SET NX EX 86400`. Value = `user_id`. Expires after 24 h. |

### Key Redis Commands

| Operation            | Command                                              |
|----------------------|------------------------------------------------------|
| Increment score      | `ZINCRBY leaderboard 10 <user_id>`                  |
| Read top 10          | `ZREVRANGE leaderboard 0 9 WITHSCORES`              |
| Claim action ID      | `SET consumed_action:<id> <user_id> EX 86400 NX`   |
| User score           | `ZSCORE leaderboard <user_id>`                      |
| User rank            | `ZREVRANK leaderboard <user_id>`                    |

> The `SET NX` (set-if-not-exists) call is atomic at the Redis level, eliminating the check-then-set race condition for replay prevention.

---

## WebSocket Live Update

- Clients connect to `wss://<host>/ws/scoreboard` on page load.
- The server maintains an in-memory set of active WebSocket connections (the **hub**).
- After every successful score write:
  1. Server fetches top 10 via `ZREVRANGE`.
  2. Server broadcasts `{ type: "snapshot", scores: [...], updated_at }` to all open connections.
- Clients that connect mid-session receive the **last cached snapshot** immediately so the board is never blank on load.
- The hub stores the last snapshot in memory; new connections get it without a Redis round-trip.

---

## Security Design

### Authentication
- All score-write endpoints require a valid **JWT** signed by the auth service.
- The JWT contains `user_id`, `username`, and `exp`. The server never trusts the client-supplied `user_id` — it is always extracted from the verified token.
- JWT is verified locally using the auth service's **public key** — no network round-trip on every request.

### Action ID Signing (Defense-in-Depth)
- `action_id` values are **server-issued and HMAC-signed**: `action_id = base64(nonce | HMAC-SHA256(secret, nonce + user_id + action_type + expiry))`.
- The API server verifies the signature before touching Redis, so a fabricated or tampered `action_id` is rejected at zero cost without a Redis lookup.
- After signature verification, `SET NX` prevents replay.

### Replay Attack Prevention
- On `POST /scores/increment`, the server atomically executes `SET consumed_action:<id> <user_id> EX 86400 NX`.
  - `OK` → first use, proceed.
  - `nil` → already consumed, return `409 Conflict`.
- Keys expire automatically after 24 h, so Redis memory is bounded without a background job.

### Score Increment Validation
- The server defines the **fixed increment value** per action type — the client never sends the increment amount. This prevents clients from sending arbitrary score deltas.

---

## Session Management

### Access Token + Refresh Token Pattern

A plain JWT works for authentication but cannot be invalidated before expiry — a stolen token is valid until it expires. The solution is a **two-token model**:

| Token | Lifetime | Where stored | Purpose |
|-------|----------|-------------|---------|
| **Access token** (JWT) | 15 min | Memory (JS variable) | Sent on every API request. Short-lived so a stolen token expires quickly. |
| **Refresh token** (opaque, random) | 7 days | `HttpOnly; Secure; SameSite=Strict` cookie | Used only to obtain a new access token. Never accessible to JavaScript. |

```
Client                          Auth Service              Redis
  │                                 │                       │
  │── POST /auth/refresh ──────────►│                       │
  │   (refresh token in cookie)     │── GET session:<token> ►│
  │                                 │◄─ session data ───────│
  │                                 │── validate + issue    │
  │◄─ 200 { access_token } ────────│   new access token    │
  │   (new JWT, 15 min)             │                       │
```

### Session Storage in Redis

Refresh tokens are stored in Redis as a hash under `session:<token>`:

| Field | Value |
|-------|-------|
| `user_id` | The authenticated user |
| `issued_at` | Unix timestamp |
| `expires_at` | Unix timestamp (7 days) |
| `user_agent` | Browser fingerprint for anomaly detection |

```
HSET session:<token> user_id u1 issued_at 1716864000 expires_at 1717468800
EXPIRE session:<token> 604800   // 7 days in seconds
```

### Token Revocation

Because refresh tokens live in Redis, revocation is instant:

| Trigger | Action |
|---------|--------|
| User logs out | `DEL session:<token>` |
| User changes password | `DEL session:<token>` for all sessions of that user |
| Account suspended | Add `user_id` to a Redis blocklist (`SET blocklist:<user_id> 1`) checked on every access token validation |
| Suspicious activity detected | Same as account suspended, plus alert the security team |

For the access token (JWT), the server checks the **blocklist** on each request:
```
if GET blocklist:<user_id> exists → return 401
```
This adds one O(1) Redis read per request but allows immediate invalidation of short-lived JWTs without waiting for their `exp` to pass.

### Concurrent Session Limits

To prevent session proliferation (e.g., token theft from multiple devices), cap active sessions per user:

```
sessions:<user_id>  →  Redis Set of active refresh tokens
```

On new login:
1. `SADD sessions:<user_id> <new_token>`
2. If `SCARD sessions:<user_id>` > 5, evict the oldest by checking `issued_at` on each session hash and deleting the stalest.

### Cookie Security

Refresh tokens are delivered as cookies with maximum protection flags:

```
Set-Cookie: refresh_token=<token>;
  HttpOnly;           // JS cannot access — XSS-proof
  Secure;             // HTTPS only
  SameSite=Strict;    // not sent on cross-site requests — CSRF-proof
  Path=/auth;         // scoped to the refresh endpoint only
  Max-Age=604800
```

Because `SameSite=Strict` prevents the cookie from being sent on cross-origin requests, no additional CSRF token is needed for the refresh endpoint.

---

## Rate Limiting

Rate limiting is enforced at three layers, each catching a different class of abuse.

### Layer 1 — Edge / CDN
Runs at the network perimeter before traffic reaches infrastructure. Protects against volumetric DDoS and bot floods.

| Limit | Window | Scope | Action |
|-------|--------|-------|--------|
| 10 000 req | 1 min | Per IP | Block at edge, return `429` |
| 500 req | 10 s | Per IP | Throttle (slow response) |
| Global burst cap | — | All traffic | Queue / shed load |

No application code involved — handled by Cloudflare WAF / AWS Shield.

### Layer 2 — API Gateway
Applied per-route before requests reach API servers. Lets different endpoints have different budgets.

| Endpoint | Limit | Window | Notes |
|----------|-------|--------|-------|
| `POST /scores/increment` | 100 req | 1 min | Per IP |
| `GET /scores/top` | 300 req | 1 min | Per IP (mostly served by cache anyway) |
| `GET /scores/me` | 120 req | 1 min | Per IP |

### Layer 3 — Application (Redis Sliding Window)
Per-authenticated-user limit on `POST /scores/increment`. This is the critical layer — it stops a legitimate-looking account from programmatically pumping scores.

**Algorithm — exact sliding window using a Redis sorted set:**
```
key  = rate:<user_id>
now  = current Unix timestamp (ms)
min  = now - 60_000              // 1-minute window

ZREMRANGEBYSCORE key -inf (min-1) // evict events outside the window
count = ZCARD key
if count >= 60:
    return 429 with Retry-After header
ZADD key now now
EXPIRE key 61
```

This is O(log N) per request and gives an **exact** window — no off-by-one errors at window boundaries like fixed-window counters. Each scored-set member is the timestamp itself, so the set self-describes the event history.

| Limit | Window | Scope |
|-------|--------|-------|
| 60 increments | 1 min | Per authenticated `user_id` |

**Rate limit response headers** — included on every `POST /scores/increment` response so clients can self-throttle:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 43
X-RateLimit-Reset: 1716864120   // Unix timestamp when the window resets
Retry-After: 17                 // only present on 429
```

**Atomicity** — the ZREMRANGEBYSCORE + ZCARD + ZADD sequence must be atomic to avoid race conditions under concurrent requests from the same user. Wrap in a **Lua script** executed via `EVAL` so Redis runs it as a single transaction:
```lua
local key   = KEYS[1]
local now   = tonumber(ARGV[1])
local min   = now - 60000
local limit = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', key, '-inf', min - 1)
local count = redis.call('ZCARD', key)
if count >= limit then return 0 end
redis.call('ZADD', key, now, now)
redis.call('EXPIRE', key, 61)
return 1
```

**Soft vs hard limits** — optionally apply a soft limit at 80% of the cap that triggers a warning header (`X-RateLimit-Warning: approaching limit`) but still allows the request, giving legitimate clients a chance to slow down before being cut off.

---

## Scaling — API Servers

API servers are stateless (JWT auth + all state in Redis), so horizontal scaling is straightforward.

```
                    ┌─────────────────────────────┐
Clients ──► ALB ──► │ API Server 1  API Server 2  │
                    │ API Server 3  API Server N  │
                    └──────────────┬──────────────┘
                                   │
                               Redis Cluster
```

- Add instances behind a load balancer; each instance reads/writes the same Redis cluster.
- JWT verification is local (public-key crypto), so the auth service is not in the hot path.
- `GET /scores/top` is read-only and served from the **top-10 cache** (see Caching section), so it scales independently.

---

## Scaling — WebSocket Hub

An in-memory hub breaks when there are multiple API server instances — a broadcast on Server 1 never reaches clients connected to Server 2.

**Solution: Redis Pub/Sub fan-out.**

```
Score write on Server 1
    │
    ├─ ZINCRBY leaderboard …       (update sorted set)
    ├─ ZREVRANGE leaderboard 0 9   (fetch top 10)
    └─ PUBLISH scoreboard:updates <top10 JSON>
                │
     ┌──────────┴──────────┐
     ▼                     ▼
Server 1 subscriber    Server 2 subscriber
  → fan-out to local     → fan-out to local
    WS clients             WS clients
```

Every API server subscribes to the `scoreboard:updates` channel on startup. When any server publishes, all subscribers receive it and push to their own connected clients. The sorted set remains the single source of truth; Pub/Sub is only for broadcasting the already-computed snapshot.

### WebSocket connection count
A single server can hold ~50–100 k concurrent WebSocket connections (limited by file descriptors and memory, not CPU). For larger audiences, dedicate a **WebSocket tier** — lightweight services whose only job is to hold connections, subscribe to Redis, and fan-out. This lets the API tier and WS tier scale independently.

---

## Scaling — Redis

### Leaderboard sorted set
A single sorted set (`ZINCRBY`, `ZREVRANGE`) handles millions of members. A single Redis node sustains ~100 k–500 k ops/sec. For the leaderboard specifically, the entire key must live on one node (sorted set operations are not distributable across shards).

| Mode | When to use |
|------|-------------|
| **Single node** | Up to ~500 k ops/sec, acceptable for most products |
| **Redis Sentinel** | Automatic failover to a replica if primary dies. Zero sharding, no ops/sec gain. Use for HA without complexity. |
| **Redis Cluster with hash tags** | Shard other keys (`consumed_action:*`, `rate:*`) but force `{leaderboard}` to a single slot using a hash tag. Adds ops/sec for high-write workloads. |

For the `consumed_action:*` and `rate:*` keys, Redis Cluster sharding is straightforward because they are independent per-key.

### Persistence
Redis is in-memory. Two options to prevent data loss on crash:

| Option | Trade-off |
|--------|-----------|
| **AOF (Append-Only File)** | Durability up to last second. Small performance cost. Recommended. |
| **RDB + async DB mirror** | On every increment, async write to Postgres. On Redis restart, replay from Postgres. Zero data loss but adds write latency. Use when scores are financial/critical. |

---

## Caching

The leaderboard is read far more than it is written. A three-tier caching strategy absorbs read traffic at each layer before it reaches Redis.

### Tier 1 — CDN / Edge Cache (public endpoints only)

`GET /scores/top` is public and identical for all users — a perfect CDN target.

```
HTTP/1.1 200 OK
Cache-Control: public, max-age=1, stale-while-revalidate=5
```

- `max-age=1`: CDN serves the cached response for up to 1 second without touching origin.
- `stale-while-revalidate=5`: while revalidating in the background, CDN continues serving the stale response for up to 5 additional seconds. Clients never wait for a cache miss.

At 100 000 req/s on `GET /scores/top`, only ~1 request/s reaches the origin. The CDN absorbs the rest.

`GET /scores/me` is user-specific — must not be cached by a shared CDN (`Cache-Control: private, no-store`).

### Tier 2 — Redis Application Cache

For the requests that do pass the CDN, the application checks a Redis string before executing `ZREVRANGE`.

```
GET /scores/top
    │
    ├─ GET top10_cache             (Redis string, TTL 1s)
    │   ├─ HIT  → return JSON immediately
    │   └─ MISS → ZREVRANGE leaderboard 0 9 WITHSCORES
    │              → build JSON
    │              → SET top10_cache <json> EX 1
    │              → return JSON
```

**Cache stampede (dog-pile) problem:** if the TTL expires and 500 requests hit simultaneously, all 500 race to rebuild the cache — causing a sudden spike of `ZREVRANGE` calls.

**Solution — mutex lock:**
```
GET top10_cache
  HIT  → return
  MISS →
    SET top10_lock 1 EX 2 NX    // try to acquire lock (2s max hold)
      OK   → rebuild cache → return (lock auto-expires)
      nil  → lock held by another request
               → WAIT 5ms → retry GET top10_cache
               → now a HIT → return (served by the rebuilder)
```
Only one request rebuilds; all others wait briefly and then hit the freshly populated cache.

Alternatively, use **probabilistic early expiry** (XFetch algorithm): recompute the cache slightly before its TTL expires with a probability that increases as expiry approaches, so the rebuild is spread over time and no thundering herd forms.

### Tier 3 — In-Process Memory Cache (server-local)

For the WebSocket snapshot, the last broadcast payload is held in memory on each server instance. New connections receive it immediately with zero latency — no Redis round-trip.

```
Client connects to WS
    │
    └─ lastSnapshot != null?
        YES → send immediately (in-memory, ~0 ms)
        NO  → client waits for next broadcast
```

This also means the WS server can serve the initial snapshot even if Redis is temporarily unavailable.

### Cache Invalidation Strategy

| Data | Cache | TTL strategy | Invalidation trigger |
|------|-------|-------------|---------------------|
| Top-10 JSON | Redis + CDN | 1 s TTL | TTL expiry (acceptable staleness) |
| WS snapshot | In-process memory | No TTL | Overwritten on every broadcast |
| JWT public key | In-process memory | 1 h TTL | Refresh on key rotation event |
| User session | Redis | 7-day TTL | Explicit `DEL` on logout / revocation |
| Rate limit window | Redis sorted set | 61 s EXPIRE | Self-expiring via `EXPIRE` |

**Event-driven invalidation for the top-10 cache:** instead of waiting for the 1 s TTL, after a successful score write the server can `DEL top10_cache` immediately so the next reader gets a fresh result. This guarantees `GET /scores/top` reflects the latest state within one CDN edge TTL (1 s). The trade-off is a slightly higher chance of a cache miss after each write — acceptable given the debouncing already limits writes to ~10/s.

### What NOT to Cache

| Data | Reason |
|------|--------|
| `GET /scores/me` | User-specific; caching would serve one user's rank to another |
| `POST /scores/increment` responses | Write endpoints are never cached |
| Rate limit counters | Must reflect live state; caching defeats the purpose |
| Consumed action IDs | Must be read-your-own-writes consistent; cache would allow replays |

---

## Broadcast Debouncing

Under burst load (thousands of users completing actions within the same second), the server would issue `ZREVRANGE` and broadcast on every single increment. This wastes Redis reads and floods clients with redundant payloads.

**Solution: debounce the broadcast with a short window.**

```
On score write:
    SET broadcast_pending 1 EX 0.1 NX   // 100 ms debounce flag

    if SET returned OK (flag was newly created):
        schedule broadcast after 100 ms:
            ZREVRANGE → publish to Pub/Sub channel
    else:
        // another write already scheduled the broadcast, skip
```

This collapses any number of increments within a 100 ms window into a single `ZREVRANGE` + broadcast. Clients see at most 10 updates/second, which is more than enough for a smooth UI, and Redis read pressure is capped.

---

## Persistent Audit Log

Redis data can be lost or evicted. For fraud investigation and dispute resolution, every increment event should be written to an immutable append-only log.

**Options:**

| Option | Notes |
|--------|-------|
| **Postgres table** | `INSERT INTO score_events (user_id, action_id, delta, scored_at)`. Durable, queryable. |
| **Redis Stream** | `XADD score_events * user_id … delta …`. Fast, ordered. Persist to S3 with a consumer group. |
| **Kafka topic** | Best for very high write rates (>100 k/s). Consumers can rebuild the leaderboard from scratch if needed. |

The audit log write can be **asynchronous** (fire-and-forget after the Redis write succeeds) so it does not add latency to the API response.

---

## Observability

| Signal | What to track |
|--------|--------------|
| **Metrics** | Score increment rate (req/s), WS connection count, Redis command latency (p50/p99), cache hit rate, rate-limit rejection rate |
| **Alerts** | Score increment rate > 10× baseline (abnormal burst), Redis latency p99 > 10 ms, WS connection drop > 20% in 1 min |
| **Anomaly detection** | Flag individual users whose increment rate exceeds their historical median by > 5×. Queue for manual review. |
| **Distributed tracing** | Trace ID propagated through HTTP → Redis → Pub/Sub → WS broadcast to diagnose latency spikes end-to-end. |

---

## Deployment Architecture (Full Picture)

```
                         ┌─────────────────────────────────────┐
                         │           Edge / CDN                │
Users ──► Cloudflare ──► │  DDoS protection, IP rate limiting  │
                         │  Cache GET /scores/top (max-age=1)  │
                         └──────────────────┬──────────────────┘
                                            │
                         ┌──────────────────▼──────────────────┐
                         │         API Gateway / ALB           │
                         │  Per-IP rate limiting, TLS offload  │
                         └─────────────┬──────────┬────────────┘
                                       │          │
                          ┌────────────▼──┐  ┌────▼────────────┐
                          │  API Servers  │  │   WS Servers    │
                          │  (stateless)  │  │  (connection    │
                          │  N instances  │  │   holders only) │
                          └────────────┬──┘  └────┬────────────┘
                                       │          │
                          ┌────────────▼──────────▼────────────┐
                          │           Redis Cluster             │
                          │  leaderboard (sorted set, 1 shard) │
                          │  consumed_action:* (sharded)        │
                          │  rate:* (sharded)                   │
                          │  Pub/Sub: scoreboard:updates        │
                          └──────────────────┬──────────────────┘
                                             │ async
                          ┌──────────────────▼──────────────────┐
                          │    Postgres / Kafka (audit log)      │
                          └─────────────────────────────────────┘
```

---

## Summary of Design Decisions

| Concern | Decision | Reason |
|---------|----------|--------|
| Score storage | Redis sorted set | O(log N) write, O(log N + K) top-K read, atomic increments |
| Replay prevention | `SET NX EX` (atomic) | Eliminates TOCTOU race; TTL auto-cleans without a cron |
| Action ID security | HMAC-signed by server | Forgery rejected before Redis is touched |
| Session model | Short-lived JWT + Redis refresh token | Stateless speed with the ability to revoke immediately |
| Token revocation | Redis blocklist on `user_id` | One O(1) read per request; instant invalidation |
| Refresh token delivery | `HttpOnly; Secure; SameSite=Strict` cookie | XSS-proof and CSRF-proof without an extra token |
| JWT verification | Local (public key) | No auth service round-trip in the hot path |
| Rate limiting — edge | IP-based at CDN/gateway | Zero app overhead; stops floods before they enter |
| Rate limiting — app | Redis sliding window + Lua script | Exact window, atomic, O(log N), self-expiring |
| WS horizontal scale | Redis Pub/Sub | Decouples broadcast from connection holder; any server can trigger |
| Broadcast efficiency | 100 ms debounce | Collapses burst writes; caps Redis reads at 10/s |
| Read traffic — L1 | CDN with `stale-while-revalidate` | Absorbs millions of requests at the edge |
| Read traffic — L2 | Redis string cache (1 s TTL) + mutex | One `ZREVRANGE`/s max; stampede-safe |
| Read traffic — L3 | In-process WS snapshot | Zero-latency initial load for WebSocket clients |
| Cache invalidation | TTL + event-driven `DEL` after write | Fresh within 1 s; event-driven for writes |
| Durability | AOF + async Postgres mirror | In-memory speed with durable fallback |
| Audit | Append-only log (async) | Zero latency impact; enables fraud replay |
