import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallRepository } from "../src/modules/calls/calls.repository";
import { CallsService } from "../src/modules/calls/calls.service";
import { RecordingService, type RecordingGateway } from "../src/modules/recordings/recordings.service";
import { validateTwilioStartContext } from "../src/modules/realtime/twilio-media.bridge";
import { InMemoryTimingRepository, TimingService } from "../src/modules/timing/timing.service";
import { ApiError } from "../src/shared/http/api-error";
import { InMemoryJobQueue } from "../src/shared/queue/in-memory-job-queue";

async function createCalls(count = 1) {
  const repository = new InMemoryCallRepository();
  const queue = new InMemoryJobQueue({ concurrency: 3 });
  let id = 0;
  const calls = new CallsService({
    repository,
    queue,
    contextResolver: { resolve: async () => ({ toNumber: "+525500000001" }) },
    telephonyGateway: {
      startOutboundCall: async (input) => ({ providerCallId: `CA_${input.callId}` }),
    },
    createId: () => `call_${String.fromCharCode(65 + id++)}`,
  });
  for (let index = 0; index < count; index += 1) {
    await calls.enqueueOutbound({ operationId: "op_1", carrierId: `car_${index}`, purpose: "QUOTE" });
  }
  await queue.onIdle();
  return calls;
}

describe("Voice call identity hardening", () => {
  it("accepts the correct CallSid/StreamSid and rejects every cross-call combination", async () => {
    const calls = await createCalls(3);
    await Promise.all([
      calls.ensureStreamIdentity("call_A", "CA_call_A", "MZ_A"),
      calls.ensureStreamIdentity("call_B", "CA_call_B", "MZ_B"),
      calls.ensureStreamIdentity("call_C", "CA_call_C", "MZ_C"),
    ]);
    assert.equal((await calls.getById("call_A")).twilioStreamSid, "MZ_A");
    assert.equal((await calls.getById("call_B")).twilioStreamSid, "MZ_B");
    assert.equal((await calls.getById("call_C")).twilioStreamSid, "MZ_C");

    await assert.rejects(
      () => calls.ensureStreamIdentity("call_B", "CA_call_B", "MZ_A"),
      (error: unknown) => error instanceof ApiError && error.code === "STREAM_ID_CONFLICT",
    );
    await assert.rejects(
      () => calls.ensureStreamIdentity("call_A", "CA_call_B", "MZ_A"),
      (error: unknown) => error instanceof ApiError && error.code === "CALL_PROVIDER_ID_CONFLICT",
    );
    assert.deepEqual(
      validateTwilioStartContext("call_A", {
        callSid: "CA_call_A",
        streamSid: "MZ_A",
        customParameters: { callId: "call_A" },
      }),
      { callSid: "CA_call_A", streamSid: "MZ_A" },
    );
    assert.throws(
      () => validateTwilioStartContext("call_A", {
        callSid: "CA_call_A",
        streamSid: "MZ_A",
        customParameters: { callId: "call_B" },
      }),
      (error: unknown) => error instanceof ApiError && error.code === "CALL_CONTEXT_MISMATCH",
    );
  });

  it("starts recording after CallSid and handles duplicate callbacks idempotently", async () => {
    const calls = await createCalls(2);
    const starts: Array<{ callSid: string; statusCallbackUrl: string }> = [];
    const gateway: RecordingGateway = {
      start: async (input) => {
        starts.push(input);
        return { recordingSid: "RE_1", status: "in-progress" };
      },
    };
    const service = new RecordingService(calls, gateway, "https://voice.example.test");
    await Promise.all([service.start("call_A"), service.start("call_A")]);
    assert.equal(starts.length, 1);
    assert.match(starts[0]!.statusCallbackUrl, /recording-status\?callId=call_A/);

    const callback = {
      callId: "call_A",
      callSid: "CA_call_A",
      recordingSid: "RE_1",
      status: "completed",
      recordingUrl: "https://api.twilio.com/recordings/RE_1",
      durationSeconds: 42,
    };
    await service.receiveStatus(callback);
    await service.receiveStatus(callback);
    const call = await calls.getById("call_A");
    assert.equal(call.recordingSid, "RE_1");
    assert.equal(call.recordingStatus, "COMPLETED");
    assert.equal(call.recordingDurationSeconds, 42);
    await assert.rejects(
      () => service.receiveStatus({ ...callback, callSid: "CA_other" }),
      (error: unknown) => error instanceof ApiError && error.code === "RECORDING_CALL_MISMATCH",
    );
    await assert.rejects(
      () => service.receiveStatus({
        ...callback,
        callId: "call_B",
        callSid: "CA_call_B",
      }),
      (error: unknown) => error instanceof ApiError && error.code === "RECORDING_CALL_MISMATCH",
    );
  });

  it("stores raw clock domains and rejects timing from another stream", async () => {
    const calls = await createCalls();
    await calls.ensureStreamIdentity("call_A", "CA_call_A", "MZ_A");
    const timing = new TimingService(calls, new InMemoryTimingRepository(), () => new Date("2026-08-29T12:00:00Z"));
    await timing.record({
      callId: "call_A",
      streamSid: "MZ_A",
      clock: "twilio_stream",
      eventType: "FIRST_MEDIA",
      rawTimestampMs: 120,
      metadata: { track: "inbound" },
    });
    assert.equal((await timing.list("call_A"))[0]?.rawTimestampMs, 120);
    await assert.rejects(
      () => timing.record({
        callId: "call_A",
        streamSid: "MZ_B",
        clock: "openai_input",
        eventType: "CALLER_SPEECH_STARTED",
        rawTimestampMs: 125,
      }),
      (error: unknown) => error instanceof ApiError && error.code === "TIMING_STREAM_MISMATCH",
    );
  });
});
