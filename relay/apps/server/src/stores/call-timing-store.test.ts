import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallTimingStore } from "./call-timing-store.js";

describe("CallTimingStore", () => {
  it("E: isolates CallSid and StreamSid pairs", () => {
    const store = new CallTimingStore();
    store.startStream("CA_A", "MZ_A");
    store.startStream("CA_B", "MZ_B");
    store.observeMedia({ streamSid: "MZ_A", timestamp: "20" });
    store.observeMedia({ streamSid: "MZ_B", timestamp: "80" });

    assert.equal(store.getByCallId("CA_A")?.stream.lastMediaTimestampMs, 20);
    assert.equal(store.getByCallId("CA_B")?.stream.lastMediaTimestampMs, 80);
    assert.equal(store.getByStreamSid("MZ_A")?.callId, "CA_A");
    assert.equal(store.getByStreamSid("MZ_B")?.callId, "CA_B");
  });

  it("F: retains first and last real media metadata", () => {
    const store = new CallTimingStore();
    store.startStream("CA_A", "MZ_A");
    store.observeMedia({
      streamSid: "MZ_A",
      timestamp: "40",
      sequenceNumber: "4",
      chunk: "3",
      track: "inbound",
    });
    store.observeMedia({
      streamSid: "MZ_A",
      timestamp: "20",
      sequenceNumber: "2",
      chunk: "1",
      track: "inbound",
    });
    store.observeMedia({
      streamSid: "MZ_A",
      timestamp: "100",
      sequenceNumber: "8",
      chunk: "7",
      track: "inbound",
    });

    assert.deepEqual(store.getByCallId("CA_A")?.stream, {
      clock: "twilio_stream",
      streamSid: "MZ_A",
      firstMediaTimestampMs: 20,
      lastMediaTimestampMs: 100,
      firstSequenceNumber: 2,
      lastSequenceNumber: 8,
      firstChunk: 1,
      lastChunk: 7,
      lastTrack: "inbound",
    });
  });

  it("G: ignores invalid and negative timestamps", () => {
    const store = new CallTimingStore();
    store.startStream("CA_A", "MZ_A");

    assert.equal(
      store.observeMedia({ streamSid: "MZ_A", timestamp: "-1" }),
      false,
    );
    assert.equal(
      store.observeMedia({ streamSid: "MZ_A", timestamp: "not-a-number" }),
      false,
    );
    assert.equal(
      store.getByCallId("CA_A")?.stream.firstMediaTimestampMs,
      undefined,
    );
  });

  it("stores OpenAI caller speech offsets under a separate clock and itemId", () => {
    const store = new CallTimingStore();
    store.startStream("CA_A", "MZ_A");
    assert.equal(store.observeSpeechStarted("CA_A", "item_1", 120), true);
    assert.equal(store.observeSpeechStopped("CA_A", "item_1", 940), true);

    assert.deepEqual(store.getByCallId("CA_A")?.callerSpeechRanges, [
      {
        clock: "openai_input",
        itemId: "item_1",
        startMs: 120,
        endMs: 940,
      },
    ]);
  });
});
