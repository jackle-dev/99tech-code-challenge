export interface Score {
  id: number;
  user_id: string;
  username: string;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface CreateScoreBody {
  user_id: string;
  username: string;
  score?: number;
}

export interface UpdateScoreBody {
  username?: string;
  score?: number;
}

export interface ScoreFilter {
  username?: string;
  min_score?: number;
  max_score?: number;
  limit: number;
  offset: number;
}
