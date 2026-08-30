import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

migrate(db, { migrationsFolder });
process.stdout.write(`SQLite migrations applied from ${migrationsFolder}\n`);
