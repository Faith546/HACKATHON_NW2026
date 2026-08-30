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
});
