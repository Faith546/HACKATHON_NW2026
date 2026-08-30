import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Express } from "express";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../../src/db/schema";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function createBusinessFlowDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const database = drizzle(sqlite, { schema });
  migrate(database, {
    migrationsFolder: path.join(projectRoot, "src/db/migrations"),
  });
  return { sqlite, database };
}

export type BusinessFlowDatabase = ReturnType<
  typeof createBusinessFlowDatabase
>["database"];

export async function startTestApp(app: Express): Promise<{
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
