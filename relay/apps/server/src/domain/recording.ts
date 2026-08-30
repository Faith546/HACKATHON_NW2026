export const recordingStatuses = [
  "in-progress",
  "paused",
  "stopped",
  "processing",
  "completed",
  "absent",
  "unknown",
] as const;

export type RecordingStatus = (typeof recordingStatuses)[number];

export type RecordingReference = {
  callId: string;
  recordingSid: string;
  status: RecordingStatus;
  /** Server wall-clock metadata. This is not an audio evidence timestamp. */
  startRequestedAt?: string;
  /** Absolute start time reported by Twilio when available. */
  startedAt?: string;
  durationMs?: number;
  channels?: number;
  track?: string;
  source?: string;
};
