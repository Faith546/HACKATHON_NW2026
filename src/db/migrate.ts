import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./index";
import { baselineCompatibleDatabase } from "./migration-baseline";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const baselined = baselineCompatibleDatabase(sqlite, migrationsFolder);
migrate(db, { migrationsFolder });
if (baselined) {
  process.stdout.write("SQLite preexistente adoptado como baseline 0000.\n");
}
process.stdout.write(`SQLite migrations applied from ${migrationsFolder}\n`);
