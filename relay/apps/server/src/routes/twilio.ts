import type { FastifyPluginAsync } from "fastify";
import twilio from "twilio";

type TwilioCallBody = {
  CallSid?: string;
  CallStatus?: string;
  From?: string;
  To?: string;
};

function mediaWebSocketUrl(): string {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  if (!publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is required when VOICE_MODE=realtime");
  }

  const url = new URL(publicBaseUrl);
  if (url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS when VOICE_MODE=realtime");
  }

  url.protocol = "wss:";
  url.pathname = "/media/twilio";
  url.search = "";
  url.hash = "";

  return url.toString();
}

const twilioRoutes: FastifyPluginAsync = async (app) => {
  // TODO(checkpoint 2): validate X-Twilio-Signature here before handling requests.
  app.post<{ Body: TwilioCallBody }>("/voice/inbound", async (request, reply) => {
    const { CallSid, From, To } = request.body ?? {};

    console.info(
      [
        "Incoming Twilio call",
        `CallSid: ${CallSid ?? "unknown"}`,
        `From: ${From ?? "unknown"}`,
        `To: ${To ?? "unknown"}`,
      ].join("\n"),
    );

    const response = new twilio.twiml.VoiceResponse();
    const voiceMode = process.env.VOICE_MODE?.toLowerCase() || "say";

    if (voiceMode === "say") {
      response.say({ language: "en-US", voice: "alice" }, "Relay is online.");
    } else if (voiceMode === "realtime") {
      const streamUrl = mediaWebSocketUrl();
      response.connect().stream({ url: streamUrl });
      console.info(`[VOICE] Twilio stream URL: ${streamUrl}`);
    } else {
      throw new Error(`Unsupported VOICE_MODE: ${voiceMode}`);
    }

    return reply.type("text/xml").send(response.toString());
  });

  app.post("/voice/fallback", async (_request, reply) => {
    const response = new twilio.twiml.VoiceResponse();
    response.say(
      { language: "en-US", voice: "alice" },
      "Relay is temporarily unavailable. Please try again.",
    );

    return reply.type("text/xml").send(response.toString());
  });

  app.post<{ Body: TwilioCallBody }>("/calls/status", async (request, reply) => {
    const { CallSid, CallStatus, From, To } = request.body ?? {};

    console.info(
      [
        "Twilio call status",
        `CallSid: ${CallSid ?? "unknown"}`,
        `CallStatus: ${CallStatus ?? "unknown"}`,
        `From: ${From ?? "unknown"}`,
        `To: ${To ?? "unknown"}`,
      ].join("\n"),
    );

    return reply.code(204).send();
  });
};

export default twilioRoutes;
