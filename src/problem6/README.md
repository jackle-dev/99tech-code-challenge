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

### Replay Attack Prevention
- Each server-issued action generates a **unique `action_id`** (UUID v4).
- On `POST /scores/increment`, the server atomically executes `SET consumed_action:<id> <user_id> EX 86400 NX`.
  - `OK` → first use, proceed.
  - `nil` → already consumed, return `409 Conflict`.
- Keys expire automatically after 24 h, so Redis memory is bounded without a background job.

### Score Increment Validation
- The server defines the **fixed increment value** per action type — the client never sends the increment amount. This prevents clients from sending arbitrary score deltas.

### Rate Limiting
- Apply per-user rate limiting on `POST /scores/increment` (e.g., 60 req/min) to limit score-pumping attempts.

---

## Scaling Considerations

| Concern | Approach |
|---------|----------|
| Multiple API server instances | Move the WebSocket hub to a **Redis Pub/Sub channel** (`PUBLISH`/`SUBSCRIBE`). Each instance subscribes and fans out to its local WS clients. The sorted set remains the single source of truth. |
| Read traffic on `GET /scores/top` | Cache the serialized top-10 JSON in Redis (`SET top10_cache … EX 1`) with a 1-second TTL to avoid a sorted-set read on every HTTP request. |
| Audit / fraud investigation | Append each increment event (user_id, action_id, delta, timestamp) to an immutable log (append-only Redis Stream or a database table) for after-the-fact analysis. |
| Action verification depth | Optionally call back to the action service before accepting an increment, to confirm the action was legitimately completed (defense-in-depth against stolen `action_id`s). |
