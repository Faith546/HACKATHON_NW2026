import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import yaml from "yamljs";
import { createApp } from "../src/app";

interface OpenApiDocument {
  paths: Record<string, Record<string, unknown>>;
}

describe("OpenAPI route parity", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const document = yaml.parse(
    readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"),
  ) as OpenApiDocument;
  const methods = new Set(["get", "post", "put", "patch", "delete"]);

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of Object.keys(pathItem).filter((value) => methods.has(value))) {
      it(`${method.toUpperCase()} ${path} is mounted and handles invalid input`, async () => {
        const concretePath = path.replaceAll(/\{[^}]+\}/g, "missing_contract_id");
        const response = await fetch(`${baseUrl}${concretePath}`, {
          method: method.toUpperCase(),
          headers: method === "post" ? { "content-type": "application/json" } : undefined,
          body: method === "post" ? "{}" : undefined,
        });
        const text = await response.text();
        const body = text.startsWith("{") ? JSON.parse(text) as { code?: string } : {};

        assert.notEqual(
          body.code,
          "ROUTE_NOT_FOUND",
          `${method.toUpperCase()} ${path} is declared but not mounted`,
        );
        assert.ok(
          response.status < 500,
          `${method.toUpperCase()} ${path} returned ${response.status}: ${text}`,
        );
      });
    }
  }
});
