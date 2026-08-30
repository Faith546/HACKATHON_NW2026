import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { db } from "../src/db";
import { auditEvents, mandates, operations } from "../src/db/schema";
import { createAuditOperationRouter } from "../src/modules/audit/audit.routes";
import {
  AuditWriter,
  type AuditEventRecord,
  type AuditEventRepository,
} from "../src/shared/audit/audit-writer";
import {
  errorHandler,
  notFoundHandler,
} from "../src/shared/http/error-handler";

class TemporarySqliteAuditRepository implements AuditEventRepository {
  constructor(private readonly database: Database.Database) {}

  insert(event: AuditEventRecord): void {
    this.database
      .prepare(
        `INSERT INTO audit_events (
          id, operation_id, event_type, actor_type, actor_id,
          entity_type, entity_id, mandate_id, payload_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.operationId,
        event.eventType,
        event.actorType,
        event.actorId ?? null,
        event.entityType ?? null,
        event.entityId ?? null,
        event.mandateId ?? null,
        JSON.stringify(event.payload),
        event.occurredAt,
      );
  }
}

describe("AuditWriter", () => {
  it("persists a structured event in a temporary SQLite database", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        mandate_id TEXT,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )
    `);

    try {
      const writer = new AuditWriter(
        new TemporarySqliteAuditRepository(database),
        () => new Date("2026-08-29T21:00:00.000Z"),
      );

      const event = await writer.record({
        operationId: "op_demo",
        eventType: "OPERATION_CREATED",
        actorType: "INTERNAL_OPERATOR",
        actorId: "operator_demo",
        entityType: "OPERATION",
        entityId: "op_demo",
        payload: { mandateId: "man_demo" },
      });

      const stored = database
        .prepare("SELECT * FROM audit_events WHERE id = ?")
        .get(event.id) as Record<string, unknown>;

      assert.match(event.id, /^evt_/);
      assert.equal(stored.operation_id, "op_demo");
      assert.equal(stored.event_type, "OPERATION_CREATED");
      assert.equal(stored.occurred_at, "2026-08-29T21:00:00.000Z");
      assert.deepEqual(JSON.parse(String(stored.payload_json)), {
        mandateId: "man_demo",
      });
    } finally {
      database.close();
    }
  });

  it("returns an operation timeline chronologically with payload parsed", async () => {
    const operationId = `op_audit_${randomUUID()}`;
    await db.insert(operations).values({
      id: operationId,
      customerName: "Audit Test",
      containerNumber: randomUUID().replace(/\D/g, "").padEnd(4, "0").slice(0, 4),
      origin: "A",
      destination: "B",
    });
    await db.insert(mandates).values({
      id: `man_audit_${randomUUID()}`,
      operationId,
      version: 1,
      status: "ACTIVE",
      maxTotalPriceCents: 100_000,
      currency: "MXN",
      pickupDate: "2026-09-03",
    });
    await db.insert(auditEvents).values([
      {
        id: `evt_z_${randomUUID()}`,
        operationId,
        eventType: "SECOND",
        actorType: "SYSTEM",
        payloadJson: JSON.stringify({ sequence: 2, nested: { ok: true } }),
        occurredAt: "2026-08-29T22:00:00.000Z",
      },
      {
        id: `evt_a_${randomUUID()}`,
        operationId,
        eventType: "FIRST",
        actorType: "INTERNAL_OPERATOR",
        actorId: "operator_1",
        entityType: "OPERATION",
        entityId: operationId,
        payloadJson: JSON.stringify({ sequence: 1 }),
        occurredAt: "2026-08-29T21:00:00.000Z",
      },
    ]);

    const app = express();
    app.use(
      "/api/v1/operations/:operationId/audit-events",
      createAuditOperationRouter(),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/operations/${operationId}/audit-events`,
      );
      const body = (await response.json()) as Array<Record<string, any>>;

      assert.equal(response.status, 200);
      assert.deepEqual(
        body.map((event) => event.eventType),
        ["FIRST", "SECOND"],
      );
      assert.deepEqual(body[0]?.payload, { sequence: 1 });
      assert.deepEqual(body[1]?.payload, {
        sequence: 2,
        nested: { ok: true },
      });
      assert.equal("payloadJson" in (body[0] ?? {}), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        (server as Server).close((error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
  });

  it("returns 404 instead of an empty timeline for an unknown operation", async () => {
    const app = express();
    app.use(
      "/api/v1/operations/:operationId/audit-events",
      createAuditOperationRouter(),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/operations/op_missing_${randomUUID()}/audit-events`,
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 404);
      assert.equal(body.code, "RESOURCE_NOT_FOUND");
    } finally {
      await new Promise<void>((resolve, reject) => {
        (server as Server).close((error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
  });
});
