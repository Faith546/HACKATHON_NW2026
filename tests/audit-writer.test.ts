import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  AuditWriter,
  type AuditEventRecord,
  type AuditEventRepository,
} from "../src/shared/audit/audit-writer";

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
});
