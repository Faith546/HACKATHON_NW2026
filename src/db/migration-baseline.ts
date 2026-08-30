import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";

type SqliteDatabase = InstanceType<typeof Database>;

const migrationTable = "__drizzle_migrations";

/**
 * Adopts a database created before Drizzle migration tracking was introduced.
 * A baseline is only recorded when every table and column from migration 0000
 * is already present; partial or incompatible databases fail closed.
 */
export function baselineCompatibleDatabase(
  sqlite: SqliteDatabase,
  migrationsFolder: string,
): boolean {
  if (tableExists(sqlite, migrationTable)) {
    const tracked = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM "${migrationTable}"`)
      .get() as { count: number };
    if (tracked.count > 0) return false;
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  const initialMigration = migrations[0];
  if (!initialMigration) throw new Error("No existe la migración inicial.");

  const expected = schemaAfterInitialMigration(initialMigration.sql);
  const presentApplicationTables = [...expected.keys()].filter((table) =>
    tableExists(sqlite, table),
  );
  if (presentApplicationTables.length === 0) return false;

  const incompatibilities: string[] = [];
  for (const [table, expectedColumns] of expected) {
    if (!tableExists(sqlite, table)) {
      incompatibilities.push(`tabla faltante: ${table}`);
      continue;
    }
    const actualColumns = tableColumns(sqlite, table);
    for (const column of expectedColumns) {
      if (!actualColumns.has(column)) {
        incompatibilities.push(`columna faltante: ${table}.${column}`);
      }
    }
  }
  if (incompatibilities.length > 0) {
    throw new Error(
      `SQLite preexistente incompatible; no se aplicó baseline: ${incompatibilities.join(
        ", ",
      )}.`,
    );
  }

  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "${migrationTable}" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    sqlite
      .prepare(
        `INSERT INTO "${migrationTable}" (hash, created_at) VALUES (?, ?)`,
      )
      .run(initialMigration.hash, initialMigration.folderMillis);
  })();
  return true;
}

function schemaAfterInitialMigration(
  statements: string[],
): Map<string, Set<string>> {
  const scratch = new Database(":memory:");
  try {
    scratch.pragma("foreign_keys = OFF");
    for (const statement of statements) {
      if (statement.trim()) scratch.exec(statement);
    }
    const tables = scratch
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    return new Map(
      tables.map(({ name }) => [name, tableColumns(scratch, name)]),
    );
  } finally {
    scratch.close();
  }
}

function tableExists(sqlite: SqliteDatabase, table: string): boolean {
  return Boolean(
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(table),
  );
}

function tableColumns(sqlite: SqliteDatabase, table: string): Set<string> {
  const escapedTable = table.replaceAll('"', '""');
  const rows = sqlite
    .prepare(`PRAGMA table_info("${escapedTable}")`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
