import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema";
import { DrizzleCallRepository } from "../src/modules/calls/calls.repository";
import type { Call } from "../src/modules/calls/calls.types";
import { DrizzleAuditEventRepository } from "../src/shared/audit/drizzle-audit.repository";
import { AuditWriter } from "../src/shared/audit/audit-writer";

function createDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE calls (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      carrier_id TEXT,
      negotiation_id TEXT,
      twilio_call_sid TEXT UNIQUE,
      twilio_stream_sid TEXT UNIQUE,
      recording_sid TEXT UNIQUE,
      recording_status TEXT,
      recording_url TEXT,
      recording_duration_seconds INTEGER,
      realtime_session_id TEXT,
      direction TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      from_number TEXT,
      to_number TEXT,
      transcript_text TEXT,
      brief_json TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      call_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      mandate_id TEXT,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
  return { sqlite, database: drizzle(sqlite, { schema }) };
}

describe("DrizzleCallRepository", () => {
  it("persists the call, transcript, brief and lifecycle correlation", async () => {
    const { sqlite, database } = createDatabase();
    const repository = new DrizzleCallRepository(database);
    const call: Call = {
      id: "call_db",
      operationId: "op_db",
      carrierId: "car_db",
      negotiationId: "neg_db",
      twilioCallSid: null,
      twilioStreamSid: null,
      recordingSid: null,
      recordingStatus: null,
      recordingUrl: null,
      recordingDurationSeconds: null,
      realtimeSessionId: null,
      direction: "OUTBOUND",
      purpose: "QUOTE",
      status: "QUEUED",
      fromNumber: null,
      toNumber: "+525500000001",
      transcript: null,
      brief: null,
      startedAt: null,
      endedAt: null,
      createdAt: "2026-08-29T12:00:00.000Z",
    };

    try {
      await repository.insert(call);
      await repository.setProviderCallId(call.id, "CA_DB");
      await repository.setStreamSid(call.id, "MZ_DB");
      await repository.setRecording(call.id, {
        recordingSid: "RE_DB",
        recordingStatus: "IN_PROGRESS",
      });
      await repository.setRealtimeSessionId(call.id, "rts_db");
      await repository.saveTranscript(call.id, "[0.0s] HUMAN: Hola");
      await repository.saveBrief(call.id, {
        callId: call.id,
        summary: "Carrier disponible",
        outcome: "QUOTE_OBTAINED",
        mentions: [],
        objections: [],
        actions: ["Quote registrada"],
        nextSteps: [],
        generatedAt: "2026-08-29T12:01:00.000Z",
      });
      const transition = await repository.transitionStatusByProviderCallId(
        "CA_DB",
        {
          expectedStatus: "QUEUED",
          status: "IN_PROGRESS",
          startedAt: "2026-08-29T12:00:10.000Z",
        },
      );
      const stored = await repository.findByProviderCallId("CA_DB");

      assert.equal(transition?.changed, true);
      assert.equal(stored?.realtimeSessionId, "rts_db");
      assert.equal(stored?.twilioStreamSid, "MZ_DB");
      assert.equal(stored?.recordingSid, "RE_DB");
      assert.equal(stored?.status, "IN_PROGRESS");
      assert.equal(stored?.transcript, "[0.0s] HUMAN: Hola");
      assert.equal(stored?.brief?.outcome, "QUOTE_OBTAINED");
    } finally {
      sqlite.close();
    }
  });

  it("provides the official audit adapter for Parte A composition", async () => {
    const { sqlite, database } = createDatabase();
    const writer = new AuditWriter(
      new DrizzleAuditEventRepository(database),
      () => new Date("2026-08-29T12:00:00.000Z"),
    );
    try {
      await writer.record({
        operationId: "op_db",
        eventType: "CALL_QUEUED",
        actorType: "SYSTEM",
        callId: "call_db",
      });
      const stored = sqlite
        .prepare("SELECT event_type, payload_json FROM audit_events")
        .get() as Record<string, unknown>;
      assert.equal(stored.event_type, "CALL_QUEUED");
      assert.equal(stored.payload_json, "{}");
    } finally {
      sqlite.close();
    }
  });
});
