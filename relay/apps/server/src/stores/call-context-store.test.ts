import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryCallContextStore } from "./call-context-store.js";

const baseContext = {
  operationId: "op_test",
  mandateVersion: 1,
};

describe("InMemoryCallContextStore latest call", () => {
  it("selects the greatest observed startedAt deterministically", () => {
    const store = new InMemoryCallContextStore();
    store.startCall({
      ...baseContext,
      callId: "CA_NEWER",
      startedAt: "2026-08-29T18:02:00.000Z",
    });
    store.startCall({
      ...baseContext,
      callId: "CA_OLDER",
      startedAt: "2026-08-29T18:01:00.000Z",
    });

    assert.equal(store.getLatest()?.callId, "CA_NEWER");
  });

  it("uses CallSid as a stable tie-breaker", () => {
    const store = new InMemoryCallContextStore();
    const startedAt = "2026-08-29T18:02:00.000Z";
    store.startCall({ ...baseContext, callId: "CA_A", startedAt });
    store.startCall({ ...baseContext, callId: "CA_B", startedAt });

    assert.equal(store.getLatest()?.callId, "CA_B");
  });
});
