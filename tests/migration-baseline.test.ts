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
        created_at, updated_at
      ) VALUES (
        'op_migration', 'Customer migration', 'CONT-MIGRATION',
        'Origen', 'Destino',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
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
    const preservedNegotiation = sqlite
      .prepare(
        "SELECT campaign_id AS campaignId FROM negotiations WHERE id = ?",
      )
      .get("neg_migration") as { campaignId: string } | undefined;
    assert.deepEqual(preservedNegotiation, { campaignId: "cmp_migration" });
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
});
