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
Client                   API Server               Database          WebSocket Hub
  |                          |                        |                   |
  |-- POST /scores/increment |                        |                   |
  |   (JWT + action_id)      |                        |                   |
  |                          |-- Verify JWT           |                   |
  |                          |   extract user_id      |                   |
  |                          |                        |                   |
  |                          |-- Check action_id  --->|                   |
  |                          |   not already used     |                   |
  |                          |<-- OK / 409 Conflict --|                   |
  |                          |                        |                   |
  |                          |-- Mark action_id used->|                   |
  |                          |-- UPDATE score      --->|                   |
  |                          |<-- new_score -----------|                   |
  |                          |                        |                   |
  |<-- 200 { new_score } ----|                        |                   |
  |                          |                        |                   |
  |                          |-- Fetch top 10 ------->|                   |
  |                          |<-- top 10 rows --------|                   |
  |                          |                        |                   |
  |                          |-- Broadcast update ----------------------->|
  |                          |                        |    (top 10 JSON)  |
  |                          |                        |                   |
  |<============================= WS push (top 10) ======================|
  |   (all connected clients)                                             |
```

---

## Security Design

### Authentication
- All score-write endpoints require a valid **JWT** signed by the auth service.
- The JWT contains `user_id` and `exp`. The server never trusts the client-supplied `user_id` — it is always extracted from the verified token.

### Replay Attack Prevention
- Each action generates a **unique `action_id`** (UUID v4) on the server side when the action is initiated.
- The API server stores consumed `action_id` values in the database with a TTL.
- A second `POST /scores/increment` with the same `action_id` returns `409 Conflict`.

### Rate Limiting
- Apply per-user rate limiting on `POST /scores/increment` (e.g., 60 req/min) to limit brute-force score pumping.

### Score Increment Validation
- The server defines the **fixed increment value** per action type — the client never sends the increment amount. This prevents clients from sending arbitrary score deltas.

---

## Live Update (WebSocket)

- Clients connect to `wss://<host>/ws/scoreboard` on page load.
- After any successful score update, the server fetches the top 10 and broadcasts the result to **all connected clients** via the WebSocket hub.
- Clients that disconnect and reconnect receive the latest snapshot on connection.

---

## Data Schema

```sql
-- User scores
CREATE TABLE scores (
  user_id    TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  score      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Consumed action IDs (replay prevention)
CREATE TABLE consumed_actions (
  action_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  consumed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_consumed_at ON consumed_actions(consumed_at);
-- Periodically purge rows older than action TTL (e.g. 24h) via a background job
```

---

## Suggested Improvements

1. **Cache the top-10 result** (e.g., Redis with 1s TTL) to avoid hitting the DB on every broadcast when concurrent actions arrive in bursts.
2. **Separate the WebSocket hub** into its own service so the API server can scale horizontally without losing broadcast subscribers (use a pub/sub channel like Redis Pub/Sub).
3. **Persist WebSocket state** — store the latest top-10 snapshot in cache so newly connected clients get it immediately without a DB query.
4. **Audit log** — append each increment event (user_id, action_id, delta, timestamp) to an immutable log table for fraud investigation.
5. **Action verification callback** — before accepting an increment, optionally call back to the action service to confirm the action is legitimately completed (defense-in-depth against stolen `action_id`s).
