import { Router } from "express";

export function createVoiceRouter(): Router {
  const router = Router();

  // Calls, Realtime, incidents, escalations, execution and Twilio webhooks
  // are mounted here by the voice-runtime workstream.

  return router;
}
