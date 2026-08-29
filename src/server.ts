import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { TwilioMediaBridge } from "./modules/realtime/twilio-media.bridge";
import { createVoiceRuntime } from "./modules/voice/voice.runtime";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const voiceRuntime = createVoiceRuntime();
const app = createApp({ voice: { runtime: voiceRuntime } });
const server = createServer(app);

if (
  process.env.OPENAI_API_KEY &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.PUBLIC_WSS_URL
) {
  new TwilioMediaBridge(
    voiceRuntime.callsService,
    voiceRuntime.realtimeService,
    {
      apiKey: process.env.OPENAI_API_KEY,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
      publicWssUrl: process.env.PUBLIC_WSS_URL,
      model: process.env.REALTIME_MODEL,
      voice: process.env.REALTIME_VOICE,
    },
  ).attach(server);
}

server.listen(port, host, () => {
  process.stdout.write(`API: http://${host}:${port}/api/v1\n`);
  process.stdout.write(`Swagger UI: http://${host}:${port}/docs\n`);
  process.stdout.write(`OpenAPI YAML: http://${host}:${port}/openapi.yaml\n`);
});

function shutdown(signal: string): void {
  process.stdout.write(`${signal} received, closing HTTP server\n`);
  server.close((error) => {
    if (error) {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
