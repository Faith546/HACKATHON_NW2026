import assert from "node:assert/strict";
import { describe, it } from "node:test";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import evidenceDebugRoutes from "./evidence-debug.js";
import mediaRoutes from "./media.js";
import twilioRoutes from "./twilio.js";
import { callContextStore } from "../stores/call-context-store.js";
import { callTimingStore } from "../stores/call-timing-store.js";
import { recordingStore } from "../stores/recording-store.js";

describe("Checkpoint 4 routes", () => {
  it("keeps VOICE_MODE=say and VOICE_MODE=realtime TwiML working", async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(twilioRoutes, { prefix: "/webhooks/twilio" });

    const previousMode = process.env.VOICE_MODE;
    const previousBaseUrl = process.env.PUBLIC_BASE_URL;
    try {
      process.env.VOICE_MODE = "say";
      const say = await app.inject({
        method: "POST",
        url: "/webhooks/twilio/voice/inbound",
        payload: { CallSid: "CA_ROUTE" },
      });
      assert.equal(say.statusCode, 200);
      assert.match(say.body, /Relay is online\./);

      process.env.VOICE_MODE = "realtime";
      process.env.PUBLIC_BASE_URL = "https://relay.example.test";
      const realtime = await app.inject({
        method: "POST",
        url: "/webhooks/twilio/voice/inbound",
        payload: { CallSid: "CA_ROUTE" },
      });
      assert.equal(realtime.statusCode, 200);
      assert.match(realtime.body, /<Connect>/);
      assert.match(
        realtime.body,
        /wss:\/\/relay\.example\.test\/media\/twilio/,
      );
    } finally {
      if (previousMode === undefined) delete process.env.VOICE_MODE;
      else process.env.VOICE_MODE = previousMode;
      if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousBaseUrl;
      await app.close();
    }
  });

  it("accepts a valid idempotent recording callback", async () => {
    const app = Fastify();
    await app.register(formbody);
    await app.register(twilioRoutes, { prefix: "/webhooks/twilio" });

    const payload = {
      CallSid: "CA_ROUTE_CALLBACK",
      RecordingSid: "RE_ROUTE_CALLBACK",
      RecordingStatus: "completed",
      RecordingDuration: "12",
    };
    const first = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/recordings/status",
      payload,
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/recordings/status",
      payload,
    });

    assert.equal(first.statusCode, 204);
    assert.equal(repeated.statusCode, 204);
    assert.equal(
      recordingStore.getByCallId("CA_ROUTE_CALLBACK")?.durationMs,
      12000,
    );
    await app.close();
  });

  it("registers /media/twilio without opening a server", async () => {
    const app = Fastify();
    await app.register(websocket);
    await app.register(mediaRoutes);
    await app.ready();

    assert.match(app.printRoutes(), /media\/twilio/);
    await app.close();
  });

  it("returns recording, timing, and unresolved evidence diagnostics", async () => {
    const callId = "CA_ROUTE_DEBUG";
    callTimingStore.startStream(callId, "MZ_ROUTE_DEBUG");
    callTimingStore.observeMedia({
      streamSid: "MZ_ROUTE_DEBUG",
      timestamp: "250",
    });
    recordingStore.upsert({
      callId,
      recordingSid: "RE_ROUTE_DEBUG",
      status: "completed",
      durationMs: 1000,
    });

    const app = Fastify();
    await app.register(evidenceDebugRoutes);

    for (const suffix of ["recording", "timing", "evidence-debug"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/calls/${callId}/${suffix}`,
      });
      assert.equal(response.statusCode, 200);
    }

    const evidence = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}/evidence-debug`,
    });
    assert.equal(evidence.json().correlation.status, "UNRESOLVED");
    assert.equal(
      evidence.json().correlation.reason,
      "RECORDING_START_OFFSET_UNKNOWN",
    );
    await app.close();
  });

  it("returns the latest call and its current recording metadata", async () => {
    const callId = "CA_ROUTE_LATEST";
    callContextStore.startCall({
      callId,
      operationId: "op_route_test",
      mandateVersion: 1,
      startedAt: "2099-08-29T18:00:00.000Z",
      streamSid: "MZ_ROUTE_LATEST",
    });
    recordingStore.upsert({
      callId,
      recordingSid: "RE_ROUTE_LATEST",
      status: "completed",
    });

    const app = Fastify();
    await app.register(evidenceDebugRoutes);
    const response = await app.inject({
      method: "GET",
      url: "/api/debug/calls/latest",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      callId,
      streamSid: "MZ_ROUTE_LATEST",
      recordingSid: "RE_ROUTE_LATEST",
      recordingStatus: "completed",
    });
    await app.close();
  });
});
