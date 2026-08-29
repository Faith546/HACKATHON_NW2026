import type { RecordingReference } from "../domain/recording.js";
import type {
  CallTiming,
  VerifiedRecordingClockAnchor,
} from "../domain/timing.js";

export type RecordingCorrelationResult =
  | {
      status: "CORRELATED";
      callId: string;
      streamSid: string;
      recordingSid: string;
      streamToRecordingOffsetMs: number;
      anchor: VerifiedRecordingClockAnchor;
    }
  | {
      status: "UNRESOLVED";
      reason:
        | "CALL_TIMING_NOT_AVAILABLE"
        | "RECORDING_NOT_AVAILABLE"
        | "RECORDING_START_OFFSET_UNKNOWN";
    }
  | {
      status: "INVALID";
      reason:
        | "CALL_ID_MISMATCH"
        | "STREAM_SID_MISMATCH"
        | "RECORDING_SID_MISMATCH"
        | "INVALID_ANCHOR";
    };

type CorrelationInput = {
  callId: string;
  timing?: CallTiming;
  recording?: RecordingReference;
  anchor?: VerifiedRecordingClockAnchor;
};

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function correlateRecording(
  input: CorrelationInput,
): RecordingCorrelationResult {
  if (!input.timing) {
    return { status: "UNRESOLVED", reason: "CALL_TIMING_NOT_AVAILABLE" };
  }
  if (!input.recording) {
    return { status: "UNRESOLVED", reason: "RECORDING_NOT_AVAILABLE" };
  }
  if (
    input.timing.callId !== input.callId ||
    input.recording.callId !== input.callId
  ) {
    return { status: "INVALID", reason: "CALL_ID_MISMATCH" };
  }
  if (!input.anchor) {
    return {
      status: "UNRESOLVED",
      reason: "RECORDING_START_OFFSET_UNKNOWN",
    };
  }
  if (input.anchor.streamSid !== input.timing.stream.streamSid) {
    return { status: "INVALID", reason: "STREAM_SID_MISMATCH" };
  }
  if (input.anchor.recordingSid !== input.recording.recordingSid) {
    return { status: "INVALID", reason: "RECORDING_SID_MISMATCH" };
  }
  if (
    input.anchor.verifiedBy !== "physical_test" ||
    !validTimestamp(input.anchor.streamTimestampMs) ||
    !validTimestamp(input.anchor.recordingTimestampMs)
  ) {
    return { status: "INVALID", reason: "INVALID_ANCHOR" };
  }

  return {
    status: "CORRELATED",
    callId: input.callId,
    streamSid: input.timing.stream.streamSid,
    recordingSid: input.recording.recordingSid,
    streamToRecordingOffsetMs:
      input.anchor.recordingTimestampMs - input.anchor.streamTimestampMs,
    anchor: structuredClone(input.anchor),
  };
}
