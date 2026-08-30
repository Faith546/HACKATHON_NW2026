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
});
