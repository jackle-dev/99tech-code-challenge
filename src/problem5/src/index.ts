import express, { NextFunction, Request, Response } from "express";
import scoresRouter from "./routes/scores";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use("/scores", scoresRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
