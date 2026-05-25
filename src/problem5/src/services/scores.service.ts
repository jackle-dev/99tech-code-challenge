import { scoresRepository } from "../repositories/scores.repository";
import { ConflictError, NotFoundError } from "../errors";
import { Score, ScoreFilter } from "../types";

export const scoresService = {
  list(filter: ScoreFilter): { data: Score[]; limit: number; offset: number } {
    const data = scoresRepository.findAll(filter);
    return { data, limit: filter.limit, offset: filter.offset };
  },

  getById(id: number): Score {
    const score = scoresRepository.findById(id);
    if (!score) throw new NotFoundError("Score not found");
    return score;
  },

  create(user_id: string, username: string, score: number): Score {
    try {
      return scoresRepository.create(user_id, username, score);
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint failed")) {
        throw new ConflictError("user_id already exists");
      }
      throw err;
    }
  },

  update(id: number, data: { username?: string; score?: number }): Score {
    const existing = scoresRepository.findById(id);
    if (!existing) throw new NotFoundError("Score not found");
    return scoresRepository.update(
      id,
      data.username ?? existing.username,
      data.score ?? existing.score
    );
  },

  delete(id: number): void {
    const existing = scoresRepository.findById(id);
    if (!existing) throw new NotFoundError("Score not found");
    scoresRepository.delete(id);
  },
};
