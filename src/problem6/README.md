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

## Rate Limiting

Rate limiting is enforced at two layers.

### Layer 1 — API Gateway / Edge
Applied before requests reach the API servers. Blocks obvious abuse (bots, DDoS) with zero application overhead.

| Limit | Window | Scope |
|-------|--------|-------|
| 1 000 req | 1 min | Per IP |
| Global burst cap | — | All traffic |

Exceeded requests receive `429 Too Many Requests` with a `Retry-After` header.

### Layer 2 — Application (Redis Sliding Window)
Per-user limit on `POST /scores/increment` to prevent legitimate-looking accounts from pumping scores.

**Algorithm — sliding window counter in Redis:**
```
key  = rate:<user_id>
now  = current Unix timestamp (ms)
min  = now - 60_000   (1-minute window)

ZREMRANGEBYSCORE key -inf (min-1)   // drop events outside window
count = ZCARD key
if count >= 60:
    return 429
ZADD key now now
EXPIRE key 61
```
This is O(log N) per request and gives an exact sliding window with no memory leak.

| Limit | Window | Scope |
|-------|--------|-------|
| 60 increments | 1 min | Per authenticated user |

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

### Top-10 response cache
`GET /scores/top` is a public endpoint that could receive very high read traffic (leaderboard shown on every page). Without caching, every request issues a `ZREVRANGE` to Redis.

```
GET /scores/top
    │
    ├─ GET top10_cache               (Redis string, TTL 1s)
    │   ├─ HIT  → return cached JSON
    │   └─ MISS → ZREVRANGE → serialize → SET top10_cache EX 1 → return
```

A 1-second TTL means at most 1 `ZREVRANGE` per second regardless of how many clients poll the REST endpoint. Combined with an API gateway or CDN cache (`Cache-Control: public, max-age=1`), this can absorb millions of reads with minimal Redis load.

### WS snapshot cache
The last broadcast snapshot is held in memory on each server. New WebSocket connections receive it immediately without touching Redis.

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
| JWT verification | Local (public key) | No auth service round-trip in the hot path |
| API rate limiting | Redis sliding window (ZADD/ZCARD) | Exact window, O(log N), naturally expires |
| WS horizontal scale | Redis Pub/Sub | Decouples broadcast from connection holder; any server can trigger |
| Broadcast efficiency | 100 ms debounce | Collapses burst writes; caps Redis reads at 10/s |
| Read traffic | 1 s top-10 cache + CDN | Absorbs millions of polls with near-zero Redis load |
| Durability | AOF + async Postgres mirror | In-memory speed with durable fallback |
| Audit | Append-only log (async) | Zero latency impact; enables fraud replay |
