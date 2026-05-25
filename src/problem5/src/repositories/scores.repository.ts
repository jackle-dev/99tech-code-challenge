import db from "../db";
import { Score, ScoreFilter } from "../types";

export const scoresRepository = {
  findAll({ username, min_score, max_score, limit, offset }: ScoreFilter): Score[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (username !== undefined) {
      conditions.push("username LIKE ?");
      params.push(`%${username}%`);
    }
    if (min_score !== undefined) {
      conditions.push("score >= ?");
      params.push(min_score);
    }
    if (max_score !== undefined) {
      conditions.push("score <= ?");
      params.push(max_score);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return db
      .prepare(`SELECT * FROM scores ${where} ORDER BY score DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Score[];
  },

  findById(id: number): Score | undefined {
    return db.prepare("SELECT * FROM scores WHERE id = ?").get(id) as Score | undefined;
  },

  create(user_id: string, username: string, score: number): Score {
    const result = db
      .prepare("INSERT INTO scores (user_id, username, score) VALUES (?, ?, ?)")
      .run(user_id, username, score);
    return db.prepare("SELECT * FROM scores WHERE id = ?").get(result.lastInsertRowid) as Score;
  },

  update(id: number, username: string, score: number): Score {
    db.prepare(
      `UPDATE scores SET username = ?, score = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(username, score, id);
    return db.prepare("SELECT * FROM scores WHERE id = ?").get(id) as Score;
  },

  delete(id: number): void {
    db.prepare("DELETE FROM scores WHERE id = ?").run(id);
  },
};
