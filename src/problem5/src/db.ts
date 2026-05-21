import { DatabaseSync } from "node:sqlite";
import path from "path";

const db = new DatabaseSync(path.join(__dirname, "..", "data.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL UNIQUE,
    username   TEXT    NOT NULL,
    score      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

export default db;
