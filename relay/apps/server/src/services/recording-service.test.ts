import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRecordingCallback } from "./recording-service.js";
import { InMemoryRecordingStore } from "../stores/recording-store.js";
import {
  startTwilioRecordingForCall,
  type RecordingClient,
} from "../telephony/twilio-recording.js";

const callback = {
  CallSid: "CA_A",
  RecordingSid: "RE_A",
  RecordingStatus: "in-progress",
  RecordingDuration: "2.5",
  RecordingChannels: "1",
  RecordingTrack: "both",
  RecordingStartTime: "2026-08-29T18:00:00.000Z",
  RecordingSource: "StartCallRecordingAPI",
  RecordingUrl: "https://api.twilio.test/recording",
};

describe("Twilio recording metadata", () => {
  it("A: normalizes and stores a valid recording callback", () => {
    const store = new InMemoryRecordingStore();
    const recording = applyRecordingCallback(callback, store);

    assert.deepEqual(recording, {
      callId: "CA_A",
      recordingSid: "RE_A",
      status: "in-progress",
      startedAt: "2026-08-29T18:00:00.000Z",
      durationMs: 2500,
      channels: 1,
      track: "both",
      source: "StartCallRecordingAPI",
    });
    assert.equal("recordingUrl" in recording, false);
  });

  it("B: repeated callbacks update one RecordingSid", () => {
    const store = new InMemoryRecordingStore();
    const first = applyRecordingCallback(callback, store);
    const repeated = applyRecordingCallback(callback, store);

    assert.deepEqual(repeated, first);
    assert.deepEqual(store.getByRecordingSid("RE_A"), first);
    assert.deepEqual(store.getByCallId("CA_A"), first);
  });

  it("C: updates in-progress to completed without creating a second entity", () => {
    const store = new InMemoryRecordingStore();
    applyRecordingCallback(callback, store);
    const completed = applyRecordingCallback(
      {
        ...callback,
        RecordingStatus: "completed",
        RecordingDuration: "42",
      },
      store,
    );

    assert.equal(completed.recordingSid, "RE_A");
    assert.equal(completed.status, "completed");
    assert.equal(completed.durationMs, 42000);
    assert.deepEqual(store.getByCallId("CA_A"), completed);
  });

  it("D: never exposes CallSid A recording through CallSid B", () => {
    const store = new InMemoryRecordingStore();
    applyRecordingCallback(callback, store);

    assert.equal(store.getByCallId("CA_B"), undefined);
    assert.equal(store.getByCallId("CA_A")?.recordingSid, "RE_A");
  });

  it("starts recording with the installed Twilio SDK call shape", async () => {
    const store = new InMemoryRecordingStore();
    let receivedCallId: string | undefined;
    let receivedOptions: unknown;
    const client: RecordingClient = {
      calls(callId) {
        receivedCallId = callId;
        return {
          recordings: {
            async create(options) {
              receivedOptions = options;
              return {
                sid: "RE_STARTED",
                callSid: callId,
                status: "in-progress",
                startTime: null,
                duration: null,
                channels: 1,
                track: "both",
                source: "StartCallRecordingAPI",
              };
            },
          },
        };
      },
    };

    const recording = await startTwilioRecordingForCall("CA_START", {
      client,
      store,
      publicBaseUrl: "https://relay.example.test",
      now: () => new Date("2026-08-29T18:00:00.000Z"),
      startsByCall: new Map(),
    });

    assert.equal(receivedCallId, "CA_START");
    assert.deepEqual(receivedOptions, {
      recordingStatusCallback:
        "https://relay.example.test/webhooks/twilio/recordings/status",
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
      recordingTrack: "both",
      trim: "do-not-trim",
    });
    assert.equal(recording.startRequestedAt, "2026-08-29T18:00:00.000Z");
  });
});
