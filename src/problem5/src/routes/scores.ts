import { Router } from "express";
import { scoresController } from "../controllers/scores.controller";

const router = Router();

router.post("/", scoresController.create);
router.get("/", scoresController.list);
router.get("/:id", scoresController.getById);
router.put("/:id", scoresController.update);
router.delete("/:id", scoresController.delete);

export default router;
