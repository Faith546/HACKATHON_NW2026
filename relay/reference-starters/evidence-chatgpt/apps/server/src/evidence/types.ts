export type EvidenceSourceSpeaker = "caller" | "relay";

export type EvidenceTurn = {
  callId: string;
  turnId: string;
  speaker: EvidenceSourceSpeaker;
  text: string;
  final: boolean;
  interrupted?: boolean;
  startMs: number;
  endMs: number;
};

export type RecordingDescriptor = {
  recordingSid?: string;
  recordingUrl?: string;
  durationMs?: number;
};

export type EvidenceReference = {
  callId: string;
  turnId: string;
  excerpt: string;
  evidenceStartMs: number;
  evidenceEndMs: number;
  playbackStartMs: number;
  playbackEndMs: number;
  interrupted: boolean;
  recordingSid?: string;
  recordingUrl?: string;
};
