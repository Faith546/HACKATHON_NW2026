import { Router } from "express";

export function createCoreRouter(): Router {
  const router = Router();

  router.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service: "nextwave-voice-logistics-api",
    });
  });

  return router;
}
