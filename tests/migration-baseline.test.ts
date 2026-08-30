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

    assert.equal(
      baselineCompatibleDatabase(sqlite, migrationsFolder),
      true,
    );
    migrate(drizzle(sqlite), { migrationsFolder });
    const quoteColumns = sqlite.prepare("PRAGMA table_info(quotes)").all() as Array<{
      name: string;
    }>;
    assert.ok(quoteColumns.some((column) => column.name === "dispatcher_name"));
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

  it("upgrades a Business Rules database to Voice without losing calls", () => {
    const sqlite = new Database(":memory:");
    const migrations = readMigrationFiles({ migrationsFolder });
    assert.equal(migrations.length, 4);
    for (const migration of migrations.slice(0, 3)) {
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

    for (const statement of migrations[3]!.sql) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const call = sqlite
      .prepare("SELECT id, twilio_stream_sid, recording_sid FROM calls WHERE id = ?")
      .get("call_upgrade") as Record<string, unknown>;
    assert.deepEqual(call, {
      id: "call_upgrade",
      twilio_stream_sid: null,
      recording_sid: null,
    });
    assert.ok(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_timing_events'")
        .get(),
    );
    sqlite.close();
  });
});
