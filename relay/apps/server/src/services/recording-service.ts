import type {
  RecordingReference,
  RecordingStatus,
} from "../domain/recording.js";
import {
  recordingStore,
  type RecordingStore,
} from "../stores/recording-store.js";

export type TwilioRecordingCallbackBody = {
  CallSid?: string;
  RecordingSid?: string;
  RecordingStatus?: string;
  RecordingDuration?: string;
  RecordingChannels?: string;
  RecordingTrack?: string;
  RecordingStartTime?: string;
  RecordingSource?: string;
  RecordingUrl?: string;
};

const knownStatuses = new Set<RecordingStatus>([
  "in-progress",
  "paused",
  "stopped",
  "processing",
  "completed",
  "absent",
]);

function normalizeStatus(value: string | undefined): RecordingStatus {
  return value && knownStatuses.has(value as RecordingStatus)
    ? (value as RecordingStatus)
    : "unknown";
}

function secondsToMilliseconds(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function normalizeRecordingCallback(
  body: TwilioRecordingCallbackBody,
): RecordingReference {
  const callId = body.CallSid?.trim();
  const recordingSid = body.RecordingSid?.trim();

  if (!callId) throw new Error("Recording callback is missing CallSid");
  if (!recordingSid) {
    throw new Error("Recording callback is missing RecordingSid");
  }

  return {
    callId,
    recordingSid,
    status: normalizeStatus(body.RecordingStatus),
    startedAt: isoDate(body.RecordingStartTime),
    durationMs: secondsToMilliseconds(body.RecordingDuration),
    channels: positiveInteger(body.RecordingChannels),
    track: body.RecordingTrack?.trim() || undefined,
    source: body.RecordingSource?.trim() || undefined,
    // RecordingUrl is intentionally not persisted. Media access is derived
    // from RecordingSid and authenticated locally when needed.
  };
}

export function applyRecordingCallback(
  body: TwilioRecordingCallbackBody,
  store: RecordingStore = recordingStore,
): RecordingReference {
  return store.upsert(normalizeRecordingCallback(body));
}
