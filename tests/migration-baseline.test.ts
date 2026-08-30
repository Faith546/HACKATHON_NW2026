import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { baselineCompatibleDatabase } from "../src/db/migration-baseline";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/db/migrations",
);

describe("SQLite migration baseline", () => {
  it("adopts a compatible preexisting 0000 database and applies later migrations", () => {
    const sqlite = new Database(":memory:");
    const [initial] = readMigrationFiles({ migrationsFolder });
    for (const statement of initial.sql) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      INSERT INTO carriers (
        id, name, dispatcher_name, phone, created_at
      ) VALUES (
        'car_migration', 'Carrier migration', 'Dispatcher migration',
        '+525500000000', '2026-08-29T00:00:00.000Z'
      );
      INSERT INTO operations (
        id, customer_name, container_number, origin, destination,
        status, selected_carrier_id, created_at, updated_at
      ) VALUES (
        'op_migration', 'Customer migration', 'CONT-MIGRATION',
        'Origen', 'Destino', 'BOOKED', 'car_migration',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
      );
      INSERT INTO mandates (
        id, operation_id, version, max_total_price_cents, pickup_date, created_at
      ) VALUES (
        'man_migration', 'op_migration', 1, 900000, '2026-09-03',
        '2026-08-29T00:00:00.000Z'
      );
      INSERT INTO campaigns (
        id, operation_id, requested_carriers, created_at
      ) VALUES (
        'cmp_migration', 'op_migration', 1, '2026-08-29T00:00:00.000Z'
      );
      INSERT INTO negotiations (
        id, operation_id, campaign_id, carrier_id, created_at, updated_at
      ) VALUES (
        'neg_migration', 'op_migration', 'cmp_migration', 'car_migration',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
      );
      INSERT INTO quotes (
        id, operation_id, negotiation_id, carrier_id, total_price_cents,
        pickup_date, valid, mandate_id, valid_until, created_at
      ) VALUES (
        'quo_migration', 'op_migration', 'neg_migration', 'car_migration',
        850000, '2026-09-03', 1, 'man_migration',
        '2026-09-01T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
      );
      INSERT INTO commitments (
        id, operation_id, quote_id, carrier_id, mandate_id,
        total_price_cents, pickup_date, created_at, updated_at
      ) VALUES (
        'com_migration', 'op_migration', 'quo_migration', 'car_migration',
        'man_migration', 850000, '2026-09-03',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
      );
    `);

    assert.equal(
      baselineCompatibleDatabase(sqlite, migrationsFolder),
      true,
    );
    sqlite.pragma("foreign_keys = OFF");
    migrate(drizzle(sqlite), { migrationsFolder });
    sqlite.pragma("foreign_keys = ON");
    const quoteColumns = sqlite.prepare("PRAGMA table_info(quotes)").all() as Array<{
      name: string;
    }>;
    assert.ok(quoteColumns.some((column) => column.name === "dispatcher_name"));
    const operationColumns = sqlite
      .prepare("PRAGMA table_info(operations)")
      .all() as Array<{ name: string }>;
    assert.ok(operationColumns.some((column) => column.name === "weight_kg"));
    const campaignIndexColumns = sqlite
      .prepare("PRAGMA index_info(idx_campaigns_operation)")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      campaignIndexColumns.map((column) => column.name),
      ["operation_id", "created_at"],
    );
    const preservedRows = sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM carriers WHERE id = 'car_migration') AS carriers,
        (SELECT COUNT(*) FROM operations WHERE id = 'op_migration' AND selected_carrier_id = 'car_migration') AS operations,
        (SELECT COUNT(*) FROM campaigns WHERE id = 'cmp_migration') AS campaigns,
        (SELECT COUNT(*) FROM negotiations WHERE id = 'neg_migration') AS negotiations,
        (SELECT COUNT(*) FROM quotes WHERE id = 'quo_migration') AS quotes,
        (SELECT COUNT(*) FROM commitments WHERE id = 'com_migration') AS commitments
    `).get();
    assert.deepEqual(preservedRows, {
      carriers: 1,
      operations: 1,
      campaigns: 1,
      negotiations: 1,
      quotes: 1,
      commitments: 1,
    });
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    const tracked = sqlite
      .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    assert.equal(tracked.count, readMigrationFiles({ migrationsFolder }).length);
    sqlite.close();
  });

  it("fails closed for a partial preexisting schema", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE operations (id text PRIMARY KEY)");
    assert.throws(
      () => baselineCompatibleDatabase(sqlite, migrationsFolder),
      /SQLite preexistente incompatible/,
    );
    sqlite.close();
  });

  it("upgrades pre-Voice main through the latest migration without losing calls", () => {
    const sqlite = new Database(":memory:");
    const migrations = readMigrationFiles({ migrationsFolder });
    assert.equal(migrations.length, 7);
    for (const migration of migrations.slice(0, 4)) {
      for (const statement of migration.sql) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }
    sqlite.prepare(`
      INSERT INTO operations (
        id, customer_name, container_number, origin, destination, service,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "op_upgrade",
      "Upgrade test",
      "CONT-UPGRADE",
      "Origen",
      "Destino",
      "DRAYAGE",
      "SOURCING",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    );
    sqlite.prepare(`
      INSERT INTO calls (
        id, operation_id, direction, purpose, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "call_upgrade",
      "op_upgrade",
      "INBOUND",
      "QUOTE",
      "IN_PROGRESS",
      "2026-08-29T12:01:00.000Z",
    );

    for (const statement of migrations[4]!.sql) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.prepare(`
      INSERT INTO carriers (
        id, name, dispatcher_name, phone, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "car_upgrade",
      "Upgrade carrier",
      "Upgrade dispatcher",
      "+525500000001",
      "2026-08-29T12:02:00.000Z",
    );
    sqlite
      .prepare("UPDATE calls SET carrier_id = ? WHERE id = ?")
      .run("car_upgrade", "call_upgrade");
    for (const statement of migrations[5]!.sql) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const call = sqlite
      .prepare("SELECT id, carrier_id, actor_type, twilio_stream_sid, recording_sid FROM calls WHERE id = ?")
      .get("call_upgrade") as Record<string, unknown>;
    assert.deepEqual(call, {
      id: "call_upgrade",
      carrier_id: "car_upgrade",
      actor_type: "CARRIER",
      twilio_stream_sid: null,
      recording_sid: null,
    });
    assert.deepEqual(
      sqlite.prepare("SELECT id FROM carriers WHERE id = ?").get("car_upgrade"),
      { id: "car_upgrade" },
    );
    const operationIdColumn = sqlite
      .prepare("PRAGMA table_info(calls)")
      .all()
      .find((column) => (column as { name: string }).name === "operation_id") as
      | { notnull: number }
      | undefined;
    assert.equal(operationIdColumn?.notnull, 0);
    assert.ok(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_timing_events'")
        .get(),
    );
    sqlite.close();
  });
});
