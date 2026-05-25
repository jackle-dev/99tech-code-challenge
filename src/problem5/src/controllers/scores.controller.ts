import { NextFunction, Request, Response } from "express";
import { scoresService } from "../services/scores.service";
import { ConflictError, NotFoundError } from "../errors";

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

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
  } else {
    next(err);
  }
}

export const scoresController = {
  create(req: Request, res: Response, next: NextFunction): void {
    const { user_id, username, score } = req.body ?? {};

    if (!isNonEmptyString(user_id)) {
      res.status(400).json({ error: "user_id must be a non-empty string" });
      return;
    }
    if (!isNonEmptyString(username)) {
      res.status(400).json({ error: "username must be a non-empty string" });
      return;
    }

    const scoreVal = score ?? 0;
    if (!isNonNegativeInt(scoreVal)) {
      res.status(400).json({ error: "score must be a non-negative integer" });
      return;
    }

    try {
      const created = scoresService.create(user_id.trim(), username.trim(), scoreVal);
      res.status(201).json(created);
    } catch (err) {
      handleError(err, res, next);
    }
  },

  list(req: Request, res: Response, next: NextFunction): void {
    const { username, min_score, max_score, limit = "10", offset = "0" } =
      req.query as Record<string, string>;

    const limitNum = Number(limit);
    const offsetNum = Number(offset);

    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
      res.status(400).json({ error: "limit must be an integer between 1 and 100" });
      return;
    }
    if (!Number.isInteger(offsetNum) || offsetNum < 0) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }

    let minScore: number | undefined;
    let maxScore: number | undefined;

    if (min_score !== undefined) {
      minScore = Number(min_score);
      if (!Number.isFinite(minScore)) {
        res.status(400).json({ error: "min_score must be a valid number" });
        return;
      }
    }
    if (max_score !== undefined) {
      maxScore = Number(max_score);
      if (!Number.isFinite(maxScore)) {
        res.status(400).json({ error: "max_score must be a valid number" });
        return;
      }
    }

    try {
      const result = scoresService.list({
        username,
        min_score: minScore,
        max_score: maxScore,
        limit: limitNum,
        offset: offsetNum,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  getById(req: Request, res: Response, next: NextFunction): void {
    if (!isPositiveInt(req.params.id)) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }

    try {
      const score = scoresService.getById(Number(req.params.id));
      res.json(score);
    } catch (err) {
      handleError(err, res, next);
    }
  },

  update(req: Request, res: Response, next: NextFunction): void {
    if (!isPositiveInt(req.params.id)) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }

    const { username, score } = req.body ?? {};

    if (username !== undefined && !isNonEmptyString(username)) {
      res.status(400).json({ error: "username must be a non-empty string" });
      return;
    }
    if (score !== undefined && !isNonNegativeInt(score)) {
      res.status(400).json({ error: "score must be a non-negative integer" });
      return;
    }

    try {
      const updated = scoresService.update(Number(req.params.id), {
        username: username?.trim(),
        score,
      });
      res.json(updated);
    } catch (err) {
      handleError(err, res, next);
    }
  },

  delete(req: Request, res: Response, next: NextFunction): void {
    if (!isPositiveInt(req.params.id)) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }

    try {
      scoresService.delete(Number(req.params.id));
      res.status(204).send();
    } catch (err) {
      handleError(err, res, next);
    }
  },
};
