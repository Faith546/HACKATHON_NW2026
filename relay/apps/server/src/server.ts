import "dotenv/config";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import evidenceDebugRoutes from "./routes/evidence-debug.js";
import { registerLiveTranscriptRoutes } from "./routes/live-transcript.js";
import mediaRoutes from "./routes/media.js";
import quoteRoutes from "./routes/quotes.js";
import twilioRoutes from "./routes/twilio.js";

const port = Number(process.env.PORT ?? 5050);
const app = Fastify({ logger: true });

await app.register(formbody);
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  service: "relay-server",
}));

await app.register(twilioRoutes, { prefix: "/webhooks/twilio" });
await app.register(mediaRoutes);
await registerLiveTranscriptRoutes(app);
await app.register(quoteRoutes);
await app.register(evidenceDebugRoutes);

try {
  await app.listen({ host: "0.0.0.0", port });
  console.info(`Relay server listening on port ${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
