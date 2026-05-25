import { Router, Request, Response } from "express";
import db from "../db";
import { Score, CreateScoreBody, UpdateScoreBody } from "../types";

const router = Router();

function isPositiveInt(val: string): boolean {
  const n = Number(val);
  return Number.isInteger(n) && n > 0;
}

function isNonNegativeInt(val: unknown): boolean {
  const n = Number(val);
  return Number.isInteger(n) && n >= 0;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

// POST /scores — create a resource
router.post("/", (req: Request, res: Response) => {
  const { user_id, username, score } = req.body ?? {};

  if (!isNonEmptyString(user_id)) {
    return res.status(400).json({ error: "user_id must be a non-empty string" });
  }
  if (!isNonEmptyString(username)) {
    return res.status(400).json({ error: "username must be a non-empty string" });
  }

  const scoreVal = score ?? 0;
  if (!isNonNegativeInt(scoreVal)) {
    return res.status(400).json({ error: "score must be a non-negative integer" });
  }

  try {
    const result = db
      .prepare("INSERT INTO scores (user_id, username, score) VALUES (?, ?, ?)")
      .run(user_id.trim(), username.trim(), scoreVal);

    const created = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(result.lastInsertRowid) as Score;

    return res.status(201).json(created);
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      return res.status(409).json({ error: "user_id already exists" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /scores — list resources with basic filters
router.get("/", (req: Request, res: Response) => {
  const { username, min_score, max_score, limit = "10", offset = "0" } =
    req.query as Record<string, string>;

  const limitNum = Number(limit);
  const offsetNum = Number(offset);

  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({ error: "limit must be an integer between 1 and 100" });
  }
  if (!Number.isInteger(offsetNum) || offsetNum < 0) {
    return res.status(400).json({ error: "offset must be a non-negative integer" });
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (username !== undefined) {
    conditions.push("username LIKE ?");
    params.push(`%${username}%`);
  }
  if (min_score !== undefined) {
    const minNum = Number(min_score);
    if (!Number.isFinite(minNum)) {
      return res.status(400).json({ error: "min_score must be a valid number" });
    }
    conditions.push("score >= ?");
    params.push(minNum);
  }
  if (max_score !== undefined) {
    const maxNum = Number(max_score);
    if (!Number.isFinite(maxNum)) {
      return res.status(400).json({ error: "max_score must be a valid number" });
    }
    conditions.push("score <= ?");
    params.push(maxNum);
  }

  try {
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM scores ${where} ORDER BY score DESC LIMIT ? OFFSET ?`)
      .all(...params, limitNum, offsetNum) as Score[];

    return res.json({ data: rows, limit: limitNum, offset: offsetNum });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /scores/:id — get details of a resource
router.get("/:id", (req: Request, res: Response) => {
  if (!isPositiveInt(req.params.id)) {
    return res.status(400).json({ error: "id must be a positive integer" });
  }

  try {
    const score = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(req.params.id) as Score | undefined;

    if (!score) {
      return res.status(404).json({ error: "Score not found" });
    }
    return res.json(score);
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /scores/:id — update resource details
router.put("/:id", (req: Request, res: Response) => {
  if (!isPositiveInt(req.params.id)) {
    return res.status(400).json({ error: "id must be a positive integer" });
  }

  const { username, score } = (req.body ?? {}) as UpdateScoreBody;

  if (username !== undefined && !isNonEmptyString(username)) {
    return res.status(400).json({ error: "username must be a non-empty string" });
  }
  if (score !== undefined && !isNonNegativeInt(score)) {
    return res.status(400).json({ error: "score must be a non-negative integer" });
  }

  try {
    const existing = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(req.params.id) as Score | undefined;

    if (!existing) {
      return res.status(404).json({ error: "Score not found" });
    }

    const newUsername = username?.trim() ?? existing.username;
    const newScore = score ?? existing.score;

    db.prepare(
      `UPDATE scores SET username = ?, score = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newUsername, newScore, req.params.id);

    const updated = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(req.params.id) as Score;

    return res.json(updated);
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /scores/:id — delete a resource
router.delete("/:id", (req: Request, res: Response) => {
  if (!isPositiveInt(req.params.id)) {
    return res.status(400).json({ error: "id must be a positive integer" });
  }

  try {
    const existing = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(req.params.id) as Score | undefined;

    if (!existing) {
      return res.status(404).json({ error: "Score not found" });
    }

    db.prepare("DELETE FROM scores WHERE id = ?").run(req.params.id);
    return res.status(204).send();
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
