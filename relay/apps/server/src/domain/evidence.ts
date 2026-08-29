export type QuoteEvidence = {
  callId: string;
  turnId: string;
  evidenceStartMs?: number;
  evidenceEndMs?: number;
  recordingSid?: string;
  recordingUrl?: string;
};

// TODO(recording): populate evidence times only after correlating the Realtime
// turn with Twilio media.timestamp. Local transcript timestamps are not evidence.
