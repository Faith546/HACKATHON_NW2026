import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptTurn } from "../live/transcript.js";
import { correlateRecording } from "./recording-correlation.js";

const timing = {
  callId: "CA_A",
  stream: {
    clock: "twilio_stream" as const,
    streamSid: "MZ_A",
    firstMediaTimestampMs: 0,
    lastMediaTimestampMs: 12000,
  },
  callerSpeechRanges: [],
};

const recording = {
  callId: "CA_A",
  recordingSid: "RE_A",
  status: "completed" as const,
  durationMs: 14000,
};

describe("recording correlation", () => {
  it("H: returns UNRESOLVED without sufficient metadata", () => {
    assert.deepEqual(correlateRecording({ callId: "CA_A" }), {
      status: "UNRESOLVED",
      reason: "CALL_TIMING_NOT_AVAILABLE",
    });
  });

  it("I: never invents an offset when no verified anchor exists", () => {
    const result = correlateRecording({ callId: "CA_A", timing, recording });

    assert.deepEqual(result, {
      status: "UNRESOLVED",
      reason: "RECORDING_START_OFFSET_UNKNOWN",
    });
    assert.equal("streamToRecordingOffsetMs" in result, false);
  });

  it("J: a local transcript timestamp cannot implicitly become evidence", () => {
    const transcriptTurn: TranscriptTurn = {
      callId: "CA_A",
      turnId: "item_1",
      speaker: "caller",
      text: "La cotización es ocho mil quinientos.",
      final: true,
      timestampMs: 5000,
      interrupted: false,
    };
    const result = correlateRecording({ callId: "CA_A", timing, recording });

    assert.equal(transcriptTurn.timestampMs, 5000);
    assert.equal("evidenceStartMs" in transcriptTurn, false);
    assert.equal(result.status, "UNRESOLVED");
  });

  it("correlates only with an explicit physical-test anchor", () => {
    const result = correlateRecording({
      callId: "CA_A",
      timing,
      recording,
      anchor: {
        streamSid: "MZ_A",
        recordingSid: "RE_A",
        streamTimestampMs: 1000,
        recordingTimestampMs: 1800,
        verifiedBy: "physical_test",
      },
    });

    assert.equal(result.status, "CORRELATED");
    if (result.status === "CORRELATED") {
      assert.equal(result.streamToRecordingOffsetMs, 800);
    }
  });

  it("returns INVALID for a cross-call association", () => {
    assert.deepEqual(
      correlateRecording({
        callId: "CA_B",
        timing,
        recording: { ...recording, callId: "CA_B" },
      }),
      { status: "INVALID", reason: "CALL_ID_MISMATCH" },
    );
  });
});
