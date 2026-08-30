import twilio from "twilio";
import type { RecordingReference } from "../domain/recording.js";
import {
  recordingStore,
  type RecordingStore,
} from "../stores/recording-store.js";

type RecordingCreateOptions = {
  recordingStatusCallback: string;
  recordingStatusCallbackMethod: "POST";
  recordingStatusCallbackEvent: string[];
  recordingTrack: "both";
  trim: "do-not-trim";
};

type CreatedRecording = {
  sid: string;
  callSid: string;
  status: string;
  startTime?: Date | null;
  duration?: string | null;
  channels?: number | null;
  track?: string | null;
  source?: string | null;
};

export type RecordingClient = {
  calls(callId: string): {
    recordings: {
      create(options: RecordingCreateOptions): Promise<CreatedRecording>;
    };
  };
};

type StartRecordingDependencies = {
  client?: RecordingClient;
  store?: RecordingStore;
  publicBaseUrl?: string;
  now?: () => Date;
  startsByCall?: Map<string, Promise<RecordingReference>>;
};

const startsByCall = new Map<string, Promise<RecordingReference>>();

function normalizePublicBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS to receive Twilio callbacks");
  }
  url.search = "";
  url.hash = "";
  return url;
}

export function recordingStatusCallbackUrl(publicBaseUrl: string): string {
  const url = normalizePublicBaseUrl(publicBaseUrl);
  url.pathname = "/webhooks/twilio/recordings/status";
  return url.toString();
}

function defaultClient(): RecordingClient {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials are required to start recording");
  }
  return twilio(accountSid, authToken) as unknown as RecordingClient;
}

function durationMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function initialStatus(value: string): RecordingReference["status"] {
  return value === "in-progress" ? "in-progress" : "unknown";
}

export function startTwilioRecordingForCall(
  callId: string,
  dependencies: StartRecordingDependencies = {},
): Promise<RecordingReference> {
  const starts = dependencies.startsByCall ?? startsByCall;
  const existing = starts.get(callId);
  if (existing) return existing;

  const start = (async () => {
    const publicBaseUrl =
      dependencies.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
    if (!publicBaseUrl) {
      throw new Error("PUBLIC_BASE_URL is required to start Twilio recording");
    }

    const requestedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    console.info(`[RECORDING] start requested\nCallSid: ${callId}`);

    const created = await (dependencies.client ?? defaultClient())
      .calls(callId)
      .recordings.create({
        recordingStatusCallback: recordingStatusCallbackUrl(publicBaseUrl),
        recordingStatusCallbackMethod: "POST",
        recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
        recordingTrack: "both",
        trim: "do-not-trim",
      });

    if (created.callSid && created.callSid !== callId) {
      throw new Error("Twilio returned a recording for a different CallSid");
    }

    const recording = (dependencies.store ?? recordingStore).upsert({
      callId,
      recordingSid: created.sid,
      status: initialStatus(created.status),
      startRequestedAt: requestedAt,
      startedAt: created.startTime?.toISOString(),
      durationMs: durationMs(created.duration),
      channels: created.channels ?? undefined,
      track: created.track ?? undefined,
      source: created.source ?? undefined,
    });

    console.info(
      `[RECORDING] started\nCallSid: ${callId}\nRecordingSid: ${recording.recordingSid}`,
    );
    return recording;
  })();

  starts.set(callId, start);
  void start.catch(() => starts.delete(callId));
  return start;
}
