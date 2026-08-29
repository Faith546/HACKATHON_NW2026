import type {
  EvidenceReference,
  EvidenceTurn,
  RecordingDescriptor,
} from "./types.js";

export type EvidenceSelectionOptions = {
  playbackPaddingBeforeMs?: number;
  playbackPaddingAfterMs?: number;
  maxExcerptChars?: number;
};

export function selectEvidenceReference(
  turn: EvidenceTurn,
  recording: RecordingDescriptor = {},
  options: EvidenceSelectionOptions = {},
): EvidenceReference {
  const {
    playbackPaddingBeforeMs = 2000,
    playbackPaddingAfterMs = 1500,
    maxExcerptChars = 240,
  } = options;

  if (!turn.final) {
    throw new Error("EVIDENCE_TURN_NOT_FINAL");
  }

  if (!turn.text.trim()) {
    throw new Error("EVIDENCE_EMPTY_TEXT");
  }

  if (!Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs)) {
    throw new Error("EVIDENCE_INVALID_TIMESTAMP");
  }

  if (turn.startMs < 0 || turn.endMs < turn.startMs) {
    throw new Error("EVIDENCE_INVALID_RANGE");
  }

  const playbackStartMs = Math.max(0, turn.startMs - playbackPaddingBeforeMs);
  const unboundedPlaybackEndMs = turn.endMs + playbackPaddingAfterMs;
  const playbackEndMs =
    recording.durationMs != null
      ? Math.min(recording.durationMs, unboundedPlaybackEndMs)
      : unboundedPlaybackEndMs;

  const normalized = turn.text.replace(/\s+/g, " ").trim();
  const excerpt =
    normalized.length <= maxExcerptChars
      ? normalized
      : `${normalized.slice(0, Math.max(0, maxExcerptChars - 1)).trimEnd()}…`;

  return {
    callId: turn.callId,
    turnId: turn.turnId,
    excerpt,
    evidenceStartMs: turn.startMs,
    evidenceEndMs: turn.endMs,
    playbackStartMs,
    playbackEndMs,
    interrupted: Boolean(turn.interrupted),
    recordingSid: recording.recordingSid,
    recordingUrl: recording.recordingUrl,
  };
}
