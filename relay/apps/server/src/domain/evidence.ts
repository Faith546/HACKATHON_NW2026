export type RecordingEvidenceRange = {
  clock: "recording";
  recordingSid: string;
  startMs: number;
  endMs: number;
};

export type QuoteEvidence = {
  callId: string;
  turnId: string;
  range?: RecordingEvidenceRange;
};

// TODO(recording): populate range only after a verified clock correlation.
// TranscriptTurn.timestampMs is local UI/debug metadata, not evidence.
