import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tool } from "@openai/agents/realtime";
import type { z } from "zod";
import {
  parseVoiceToolArguments,
  voiceToolDescriptions,
  voiceToolParameterSchemas,
} from "../src/modules/voice/voice-tools";
import type { VoiceToolName } from "../src/modules/voice/voice-core.port";

describe("voice tool schemas", () => {
  it("converts every model-facing schema to JSON Schema", () => {
    for (const name of Object.keys(
      voiceToolParameterSchemas,
    ) as VoiceToolName[]) {
      assert.doesNotThrow(() =>
        tool({
          name,
          description: voiceToolDescriptions[name],
          parameters: voiceToolParameterSchemas[name] as z.ZodType<
            Record<string, unknown>
          >,
          execute: async () => ({ ok: true }),
        }),
      );
    }
  });

  it("keeps currency normalization in backend validation", () => {
    const parsed = parseVoiceToolArguments("evaluateOffer", {
      totalPrice: 8500,
      currency: "mxn",
      pickupDate: "2026-09-03",
    });

    assert.equal(parsed.currency, "MXN");
  });

  it("requires weight when Voice creates an operation", () => {
    const operation = {
      customerName: "Textiles Pacífico",
      containerNumber: "TCLU1234567",
      origin: "Manzanillo",
      destination: "Guadalajara",
      service: "DRAYAGE" as const,
      mandate: {
        maxTotalPrice: 9000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    };

    assert.equal(
      voiceToolParameterSchemas.createOperation.safeParse(operation).success,
      false,
    );
    assert.equal(
      voiceToolParameterSchemas.createOperation.safeParse({
        ...operation,
        weightKg: 18_000,
      }).success,
      true,
    );
  });

  it("preserves repeated container characters and rejects a missing digit", () => {
    const baseOperation = {
      customerName: "Textiles Pacífico",
      origin: "Manzanillo",
      destination: "Guadalajara",
      weightKg: 18_000,
      service: "DRAYAGE" as const,
      mandate: {
        maxTotalPrice: 9000,
        currency: "MXN",
        pickupDate: "2026-09-03",
      },
    };
    const parsed = parseVoiceToolArguments("createOperation", {
      ...baseOperation,
      containerNumber: "a, b, c, d, 1, 1, 2, 2, 3, 3, 4",
    });

    assert.equal(parsed.containerNumber, "ABCD1122334");
    assert.throws(
      () =>
        parseVoiceToolArguments("createOperation", {
          ...baseOperation,
          containerNumber: "ABCD112334",
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "VOICE_TOOL_ARGUMENTS_INVALID",
    );
  });
});
