import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { RelayLlmService } from "../src/modules/relay-llm/relay-llm.service";
import type {
  RelayLlmProvider,
  RelayOperationalContextRepository,
} from "../src/modules/relay-llm/relay-llm.types";

const contextRepository: RelayOperationalContextRepository = {
  async getContext(operationId) {
    return JSON.stringify({ operationId, operations: [{ status: "IN_TRANSIT" }] });
  },
};

describe("Relay LLM chat", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const provider: RelayLlmProvider = {
      async reply({ message, operationalContext }) {
        assert.match(message, /mandatorios/i);
        assert.match(operationalContext, /op_123/);
        return "El mandato de la operación sigue en tránsito; no hay retrasos registrados.";
      },
    };
    const service = new RelayLlmService(contextRepository, () => provider);
    server = createApp({ relayLlmService: service }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("answers an in-scope business query using backend context", async () => {
    const response = await fetch(`${baseUrl}/api/relay-llm/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "¿Qué mandatorios tienen retraso?",
        operationId: "op_123",
        context: "No debe usarse",
      }),
    });

    assert.equal(response.status, 422);

    const validResponse = await fetch(`${baseUrl}/api/relay-llm/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "¿Qué mandatorios tienen retraso?",
        operationId: "op_123",
      }),
    });
    assert.equal(validResponse.status, 200);
    assert.deepEqual(await validResponse.json(), {
      reply: "El mandato de la operación sigue en tránsito; no hay retrasos registrados.",
      inScope: true,
    });
  });

  it("rejects an out-of-scope query without using the provider", async () => {
    const response = await fetch(`${baseUrl}/api/relay-llm/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "¿Cuál es la capital de Francia?" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      reply: "Puedo ayudarte únicamente con la operación logística de Relay.",
      inScope: false,
    });
  });

  it("returns a controlled error when the API key is absent", async () => {
    const previous = process.env.CHAT_FRONTEND_API_KEY;
    delete process.env.CHAT_FRONTEND_API_KEY;
    const app = createApp({ relayLlmService: new RelayLlmService(contextRepository) });
    const temporaryServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => temporaryServer.once("listening", resolve));
    const address = temporaryServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/relay-llm/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "¿Qué retrasos hay?" }),
    });
    if (previous === undefined) delete process.env.CHAT_FRONTEND_API_KEY;
    else process.env.CHAT_FRONTEND_API_KEY = previous;
    await new Promise<void>((resolve, reject) => temporaryServer.close((error) => error ? reject(error) : resolve()));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: "LLM_NOT_CONFIGURED",
      message: "El asistente no está configurado en este entorno.",
    });
  });

  it("returns a controlled error when the provider fails", async () => {
    const failingService = new RelayLlmService(contextRepository, () => ({
      async reply() {
        throw new Error("provider failure");
      },
    }));
    const app = createApp({ relayLlmService: failingService });
    const temporaryServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => temporaryServer.once("listening", resolve));
    const address = temporaryServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/relay-llm/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "¿Qué retrasos hay?" }),
    });
    await new Promise<void>((resolve, reject) => temporaryServer.close((error) => error ? reject(error) : resolve()));

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      code: "LLM_PROVIDER_ERROR",
      message: "El asistente no está disponible temporalmente.",
    });
  });
});
