import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema";
import { ApiError } from "../src/shared/http/api-error";
import { DrizzleVoiceCoreAdapter } from "../src/modules/voice/drizzle-voice-core.adapter";

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE carriers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, dispatcher_name TEXT NOT NULL,
      phone TEXT NOT NULL, email TEXT, score INTEGER NOT NULL, active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, container_number TEXT NOT NULL,
      origin TEXT NOT NULL, destination TEXT NOT NULL, service TEXT NOT NULL,
      status TEXT NOT NULL, selected_carrier_id TEXT, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE negotiations (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
      carrier_id TEXT NOT NULL, status TEXT NOT NULL, latest_offer_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE mandates (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, version INTEGER NOT NULL,
      status TEXT NOT NULL, max_total_price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL, pickup_date TEXT NOT NULL, notes TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO carriers VALUES (
      'car_1', 'Atlas', 'Ana', '+525500000001', NULL, 90, 1, '2026-08-29T00:00:00Z'
    );
    INSERT INTO operations VALUES (
      'op_1', 'Textiles', '1234', 'Manzanillo', 'Guadalajara',
      'DRAYAGE', 'SOURCING', NULL, NULL, '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z'
    );
    INSERT INTO negotiations VALUES (
      'neg_1', 'op_1', 'cmp_1', 'car_1', 'PENDING', NULL,
      '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z'
    );
    INSERT INTO mandates VALUES (
      'man_1', 'op_1', 1, 'ACTIVE', 900000, 'MXN', '2026-09-03', NULL,
      '2026-08-29T00:00:00Z'
    );
  `);
  return { sqlite, adapter: new DrizzleVoiceCoreAdapter(drizzle(sqlite, { schema })) };
}

describe("DrizzleVoiceCoreAdapter", () => {
  it("validates outbound relationships and returns the carrier phone", async () => {
    const { sqlite, adapter } = fixture();
    try {
      assert.deepEqual(
        await adapter.resolveOutboundCallContext({
          operationId: "op_1",
          carrierId: "car_1",
          negotiationId: "neg_1",
          purpose: "QUOTE",
        }),
        { toNumber: "+525500000001" },
      );
      assert.equal((await adapter.getActiveMandate("op_1"))?.id, "man_1");
    } finally {
      sqlite.close();
    }
  });

  it("rejects a negotiation outside the requested context", async () => {
    const { sqlite, adapter } = fixture();
    try {
      await assert.rejects(
        () =>
          adapter.resolveOutboundCallContext({
            operationId: "op_1",
            carrierId: "car_1",
            negotiationId: "neg_other",
            purpose: "QUOTE",
          }),
        (error: unknown) =>
          error instanceof ApiError &&
          error.code === "NEGOTIATION_CONTEXT_MISMATCH",
      );
    } finally {
      sqlite.close();
    }
  });

  it("resolves an active inbound sourcing operation as a quote call", async () => {
    const { sqlite, adapter } = fixture();
    try {
      assert.deepEqual(
        await adapter.resolveInboundCallContext({
          fromNumber: "+525500000001",
          toNumber: "+525500000002",
        }),
        {
          operationId: "op_1",
          carrierId: "car_1",
          negotiationId: "neg_1",
          actorType: "CARRIER",
          purpose: "QUOTE",
        },
      );
    } finally {
      sqlite.close();
    }
  });

  it("lets a no-answer carrier call back while sourcing remains open", async () => {
    const { sqlite, adapter } = fixture();
    try {
      sqlite.prepare("UPDATE negotiations SET status = 'NO_ANSWER'").run();
      assert.deepEqual(
        await adapter.resolveInboundCallContext({
          fromNumber: "+525500000001",
          toNumber: "+525500000002",
        }),
        {
          operationId: "op_1",
          carrierId: "car_1",
          negotiationId: "neg_1",
          actorType: "CARRIER",
          purpose: "QUOTE",
        },
      );
    } finally {
      sqlite.close();
    }
  });

  it("lets a quoted carrier call back with a revised offer while sourcing remains open", async () => {
    const { sqlite, adapter } = fixture();
    try {
      sqlite.prepare("UPDATE negotiations SET status = 'QUOTED'").run();
      assert.deepEqual(
        await adapter.resolveInboundCallContext({
          fromNumber: "+525500000001",
          toNumber: "+525500000002",
        }),
        {
          operationId: "op_1",
          carrierId: "car_1",
          negotiationId: "neg_1",
          actorType: "CARRIER",
          purpose: "QUOTE",
        },
      );
    } finally {
      sqlite.close();
    }
  });

  it("rejects a known carrier without an active operation context", async () => {
    const { sqlite, adapter } = fixture();
    try {
      sqlite.prepare("UPDATE operations SET status = 'CANCELLED'").run();
      await assert.rejects(
        () =>
          adapter.resolveInboundCallContext({
            fromNumber: "+525500000001",
            toNumber: "+525500000002",
          }),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 422 &&
          error.code === "INBOUND_CONTEXT_UNRESOLVED",
      );
    } finally {
      sqlite.close();
    }
  });

  it("selects the most recently updated inbound operation", async () => {
    const { sqlite, adapter } = fixture();
    try {
      sqlite.exec(`
        INSERT INTO operations VALUES (
          'op_2', 'Textiles 2', 'TCLU7654321', 'Manzanillo', 'Monterrey',
          'DRAYAGE', 'BOOKED', 'car_1', NULL,
          '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z'
        );
      `);
      assert.deepEqual(
        await adapter.resolveInboundCallContext({
          fromNumber: "+525500000001",
          toNumber: "+525500000002",
        }),
        {
          operationId: "op_2",
          carrierId: "car_1",
          negotiationId: null,
          actorType: "CARRIER",
          purpose: "EXECUTION",
        },
      );
    } finally {
      sqlite.close();
    }
  });

  it("authenticates configured operator phones without selecting an operation", async () => {
    const { sqlite } = fixture();
    try {
      const adapter = new DrizzleVoiceCoreAdapter(
        drizzle(sqlite, { schema }),
        undefined,
        { authorizedOperatorPhones: ["+525500009999"] },
      );
      assert.deepEqual(
        await adapter.resolveInboundCallContext({
          fromNumber: "+525500009999",
          toNumber: "+525500000002",
        }),
        {
          operationId: null,
          carrierId: null,
          negotiationId: null,
          actorType: "INTERNAL_OPERATOR",
          purpose: "OPERATIONS",
        },
      );
    } finally {
      sqlite.close();
    }
  });

  it("delegates allowed voice tools to the official executor", async () => {
    const sqlite = new Database(":memory:");
    const executions: string[] = [];
    try {
      const adapter = new DrizzleVoiceCoreAdapter(
        drizzle(sqlite, { schema }),
        async ({ name }) => {
          executions.push(name);
          return { ok: true };
        },
      );
      assert.deepEqual(
        await adapter.executeVoiceTool({
          name: "getOperation",
          context: {
            callId: "call_1",
            operationId: "op_1",
            carrierId: null,
            negotiationId: null,
            actorType: "CARRIER",
            mandateId: null,
          },
          arguments: {},
        }),
        { ok: true },
      );
      assert.deepEqual(executions, ["getOperation"]);
    } finally {
      sqlite.close();
    }
  });
});
