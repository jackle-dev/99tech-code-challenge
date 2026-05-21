# Problem 5: A Crude Server

A CRUD REST API built with **Express.js**, **TypeScript**, and **SQLite** (via Node.js built-in `node:sqlite`).

## Requirements

- Node.js v22.5+ (uses the built-in `node:sqlite` module)
- npm

## Setup

```bash
npm install
```

## Running

**Development (TypeScript directly):**
```bash
npm run dev
```

**Production (compile then run):**
```bash
npm run build
npm start
```

The server starts on `http://localhost:3000` by default. Override with `PORT` env var:
```bash
PORT=8080 npm start
```

## API Reference

### Resource: Score

| Field      | Type   | Description              |
|------------|--------|--------------------------|
| id         | number | Auto-incremented PK      |
| user_id    | string | Unique user identifier   |
| username   | string | Display name             |
| score      | number | User's score (default 0) |
| created_at | string | ISO datetime             |
| updated_at | string | ISO datetime             |

### Endpoints

#### Create a score
```
POST /scores
Content-Type: application/json

{ "user_id": "u1", "username": "Alice", "score": 100 }
```

#### List scores (with filters)
```
GET /scores?username=alice&min_score=50&max_score=500&limit=10&offset=0
```

#### Get a score
```
GET /scores/:id
```

#### Update a score
```
PUT /scores/:id
Content-Type: application/json

{ "score": 250 }
```

#### Delete a score
```
DELETE /scores/:id
```
Returns `204 No Content` on success.

## Design Notes

- SQLite database is stored at `data.db` in the project root (auto-created on first run).
- Results are ordered by `score DESC` on list.
- `user_id` is unique — creating a duplicate returns `409 Conflict`.
