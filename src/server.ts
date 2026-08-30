import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { db } from "./db";
import { TwilioSmsSummarySender } from "./modules/calls/summary-sender";
import {
  createCommitmentsService,
  type CapableSummarySender,
  InMemoryAcceptedSummarySender,
} from "./modules/commitments/commitments.service";
import {
  createCampaignCallLifecycleObserver,
  createIntegrationService,
  type IntegrationService,
} from "./modules/integration/integration.service";
import { TwilioMediaBridge } from "./modules/realtime/twilio-media.bridge";
import { DrizzleVoiceCoreAdapter } from "./modules/voice/drizzle-voice-core.adapter";
import { createDrizzleVoiceRuntime } from "./modules/voice/voice.runtime";
import { ApiError } from "./shared/http/api-error";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const runtimeMode = validateRuntimeConfiguration();
const authorizedOperatorPhones = parseAuthorizedOperatorPhones();
const commitmentsService = createCommitmentsService({
  summarySender: configuredSummarySender(runtimeMode),
});
let integrationFacade: IntegrationService | null = null;
const voiceCore = new DrizzleVoiceCoreAdapter(
  db,
  async (input) => {
    if (!integrationFacade) {
      throw new ApiError(
        503,
        "VOICE_CORE_UNAVAILABLE",
        "El facade de integración aún no está listo.",
      );
    }
    return integrationFacade.executeVoiceTool(input);
  },
  { authorizedOperatorPhones },
);
const voiceRuntime = createDrizzleVoiceRuntime(db, {
  voiceCore,
  lifecycleObserver: createCampaignCallLifecycleObserver(
    undefined,
    async (operationId) => {
      await integrationFacade?.advanceAutonomousFlow(operationId);
    },
  ),
});
integrationFacade = createIntegrationService({
  commitmentsService,
  callsService: voiceRuntime.callsService,
  inboundContextResolver: voiceCore,
});
const app = createApp({
  core: { commitmentsService },
  voice: { runtime: voiceRuntime },
});
await integrationFacade.recoverAutonomousFlows();
const server = createServer(app);

if (runtimeMode === "twilio") {
  const openAiApiKey = requiredEnvironment("OPENAI_API_KEY");
  const twilioAuthToken = requiredEnvironment("TWILIO_AUTH_TOKEN");
  const publicWssUrl = requiredEnvironment("PUBLIC_WSS_URL");
  new TwilioMediaBridge(
    voiceRuntime.callsService,
    voiceRuntime.realtimeService,
    {
      apiKey: openAiApiKey,
      twilioAuthToken,
      publicWssUrl,
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

function configuredSummarySender(
  mode: "local" | "twilio",
): CapableSummarySender {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim() ?? "";
  if (mode === "local") {
    return new InMemoryAcceptedSummarySender();
  }
  return new TwilioSmsSummarySender({
    accountSid,
    authToken,
    fromNumber,
  });
}

function validateRuntimeConfiguration(): "local" | "twilio" {
  const mode = process.env.VOICE_RUNTIME_MODE?.trim() || "local";
  if (mode !== "local" && mode !== "twilio") {
    throw new Error("VOICE_RUNTIME_MODE debe ser local o twilio.");
  }
  if (mode === "local") return mode;

  const required = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "OPENAI_API_KEY",
    "PUBLIC_BASE_URL",
    "PUBLIC_WSS_URL",
    "AUTHORIZED_OPERATOR_PHONES",
  ] as const;
  const missing = required.filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `VOICE_RUNTIME_MODE=twilio requiere: ${missing.join(", ")}.`,
    );
  }
  const publicBaseUrl = new URL(process.env.PUBLIC_BASE_URL as string);
  const publicWssUrl = new URL(process.env.PUBLIC_WSS_URL as string);
  if (publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL debe usar https en modo twilio.");
  }
  if (publicWssUrl.protocol !== "wss:") {
    throw new Error("PUBLIC_WSS_URL debe usar wss en modo twilio.");
  }
  const escalationPhone = process.env.HUMAN_ESCALATION_PHONE?.trim();
  if (escalationPhone && !/^\+[1-9]\d{7,14}$/.test(escalationPhone)) {
    throw new Error("HUMAN_ESCALATION_PHONE debe usar formato E.164.");
  }
  parseAuthorizedOperatorPhones();
  return mode;
}

function parseAuthorizedOperatorPhones(): string[] {
  const phones = (process.env.AUTHORIZED_OPERATOR_PHONES ?? "")
    .split(",")
    .map((phone) => phone.trim())
    .filter(Boolean);
  const invalid = phones.filter((phone) => !/^\+[1-9]\d{7,14}$/.test(phone));
  if (invalid.length > 0) {
    throw new Error(
      "AUTHORIZED_OPERATOR_PHONES debe contener números E.164 separados por coma.",
    );
  }
  if (new Set(phones).size !== phones.length) {
    throw new Error("AUTHORIZED_OPERATOR_PHONES no puede contener duplicados.");
  }
  return phones;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida ${name}.`);
  }
  return value;
}
