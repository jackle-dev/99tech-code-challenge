import { Router, Request, Response } from "express";
import db from "../db";
import { Score, CreateScoreBody, UpdateScoreBody } from "../types";

const router = Router();

// POST /scores — create a resource
router.post("/", (req: Request, res: Response) => {
  const { user_id, username, score = 0 }: CreateScoreBody = req.body;

  if (!user_id || !username) {
    return res.status(400).json({ error: "user_id and username are required" });
  }

  try {
    const result = db
      .prepare("INSERT INTO scores (user_id, username, score) VALUES (?, ?, ?)")
      .run(user_id, username, score);

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
  const { username, min_score, max_score, limit = "10", offset = "0" } = req.query as Record<string, string>;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (username) {
    conditions.push("username LIKE ?");
    params.push(`%${username}%`);
  }
  if (min_score !== undefined) {
    conditions.push("score >= ?");
    params.push(Number(min_score));
  }
  if (max_score !== undefined) {
    conditions.push("score <= ?");
    params.push(Number(max_score));
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM scores ${where} ORDER BY score DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(limit), Number(offset)) as Score[];

  return res.json({ data: rows, limit: Number(limit), offset: Number(offset) });
});

// GET /scores/:id — get details of a resource
router.get("/:id", (req: Request, res: Response) => {
  const score = db
    .prepare("SELECT * FROM scores WHERE id = ?")
    .get(req.params.id) as Score | undefined;

  if (!score) {
    return res.status(404).json({ error: "Score not found" });
  }
  return res.json(score);
});

// PUT /scores/:id — update resource details
router.put("/:id", (req: Request, res: Response) => {
  const existing = db
    .prepare("SELECT * FROM scores WHERE id = ?")
    .get(req.params.id) as Score | undefined;

  if (!existing) {
    return res.status(404).json({ error: "Score not found" });
  }

  const { username, score }: UpdateScoreBody = req.body;
  const newUsername = username ?? existing.username;
  const newScore = score ?? existing.score;

  db.prepare(
    `UPDATE scores SET username = ?, score = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newUsername, newScore, req.params.id);

  const updated = db
    .prepare("SELECT * FROM scores WHERE id = ?")
    .get(req.params.id) as Score;

  return res.json(updated);
});

// DELETE /scores/:id — delete a resource
router.delete("/:id", (req: Request, res: Response) => {
  const existing = db
    .prepare("SELECT * FROM scores WHERE id = ?")
    .get(req.params.id) as Score | undefined;

  if (!existing) {
    return res.status(404).json({ error: "Score not found" });
  }

  db.prepare("DELETE FROM scores WHERE id = ?").run(req.params.id);
  return res.status(204).send();
});

export default router;
