import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRelayNegotiator,
  relayNegotiatorInstructions,
} from "../agents/relay-negotiator.js";
import type { CallContext } from "../domain/call-context.js";
import {
  quoteInputSchema,
  type AllInTotalPricing,
  type BasePlusFeesPricing,
  type QuoteInput,
} from "../domain/quote.js";
import { demoMandate } from "../fixtures/demo-operation.js";
import { InMemoryQuoteStore } from "../stores/quote-store.js";
import { recordQuote, validateQuote } from "./quote-service.js";

const validPickup = {
  pickupDate: "2026-09-03",
  pickupWindowStart: "08:00",
  pickupWindowEnd: "14:00",
} as const;

type QuoteCommonOverrides = Partial<Omit<QuoteInput, "pricing">>;
type BasePricingOverrides = Partial<
  Omit<BasePlusFeesPricing, "pricingMode">
>;
type AllInPricingOverrides = Partial<Omit<AllInTotalPricing, "pricingMode">>;

function basePlusFeesQuote(
  pricingOverrides: BasePricingOverrides = {},
  overrides: QuoteCommonOverrides = {},
): QuoteInput {
  return {
    pricing: {
      pricingMode: "BASE_PLUS_FEES",
      baseAmountMinor: 850000,
      fees: [],
      ...pricingOverrides,
    },
    currency: "MXN",
    ...validPickup,
    conditions: [],
    allInConfirmed: true,
    ...overrides,
  };
}

function allInTotalQuote(
  pricingOverrides: AllInPricingOverrides = {},
  overrides: QuoteCommonOverrides = {},
): QuoteInput {
  return {
    pricing: {
      pricingMode: "ALL_IN_TOTAL",
      quotedTotalMinor: 850000,
      ...pricingOverrides,
    },
    currency: "MXN",
    ...validPickup,
    conditions: [],
    allInConfirmed: true,
    ...overrides,
  };
}

const context: CallContext = {
  callId: "CA_TEST_NEGOTIATOR",
  operationId: demoMandate.operationId,
  mandateVersion: demoMandate.version,
  startedAt: "2026-08-29T18:00:00.000Z",
  carrierId: "carrier_test",
};

describe("deterministic quote validation", () => {
  it("A: accepts 820000 base + 30000 fees = 850000", () => {
    const result = validateQuote(
      basePlusFeesQuote({
        baseAmountMinor: 820000,
        fees: [{ label: "fuel", amountMinor: 30000 }],
      }),
      demoMandate,
    );

    assert.deepEqual(result, {
      eligible: true,
      totalAmountMinor: 850000,
      reasons: [],
    });
  });

  it("B: rejects 880000 base + 30000 fees = 910000", () => {
    const result = validateQuote(
      basePlusFeesQuote({
        baseAmountMinor: 880000,
        fees: [{ label: "fuel", amountMinor: 30000 }],
      }),
      demoMandate,
    );

    assert.equal(result.totalAmountMinor, 910000);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, ["TOTAL_EXCEEDS_MANDATE"]);
  });

  it("C: accepts 850000 with no fees inside the pickup window", () => {
    const result = validateQuote(basePlusFeesQuote(), demoMandate);

    assert.equal(result.totalAmountMinor, 850000);
    assert.equal(result.eligible, true);
    assert.deepEqual(result.reasons, []);
  });

  it("D: rejects pickup outside the mandate window", () => {
    const result = validateQuote(
      basePlusFeesQuote({}, {
        pickupWindowStart: "15:00",
        pickupWindowEnd: "16:00",
      }),
      demoMandate,
    );

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes("PICKUP_OUTSIDE_WINDOW"));
  });

  it("E: rejects USD", () => {
    const result = validateQuote(
      basePlusFeesQuote({}, { currency: "USD" }),
      demoMandate,
    );

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes("WRONG_CURRENCY"));
  });

  it("F: rejects a quote without explicit ALL-IN confirmation", () => {
    const result = validateQuote(
      basePlusFeesQuote({}, { allInConfirmed: false }),
      demoMandate,
    );

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes("ALL_IN_NOT_CONFIRMED"));
  });

  it("rejects missing base price and pickup with stable reasons", () => {
    const result = validateQuote(
      basePlusFeesQuote(
        { baseAmountMinor: null },
        {
          pickupDate: null,
          pickupWindowStart: null,
          pickupWindowEnd: null,
        },
      ),
      demoMandate,
    );

    assert.equal(result.totalAmountMinor, null);
    assert.ok(result.reasons.includes("MISSING_PRICE"));
    assert.ok(result.reasons.includes("MISSING_PICKUP"));
  });

  it("keeps BASE_PLUS_FEES behavior unchanged", () => {
    const input = basePlusFeesQuote({
      baseAmountMinor: 820000,
      fees: [{ label: "combustible", amountMinor: 30000 }],
    });
    const result = validateQuote(input, demoMandate);

    assert.equal(input.pricing.pricingMode, "BASE_PLUS_FEES");
    assert.equal(result.totalAmountMinor, 850000);
    assert.equal(result.eligible, true);
  });
});

describe("ALL_IN_TOTAL", () => {
  it("stores an eligible 850000 authoritative all-in total", async () => {
    const store = new InMemoryQuoteStore();
    const { quote, result } = await recordQuote(
      allInTotalQuote({ quotedTotalMinor: 850000 }),
      context,
      demoMandate,
      { store, createId: () => "all_in_eligible" },
    );

    assert.equal(result.eligible, true);
    assert.equal(result.totalAmountMinor, 850000);
    assert.equal(quote.pricing.pricingMode, "ALL_IN_TOTAL");
    assert.equal((await store.getQuotesForCall(context.callId)).length, 1);
  });

  it("stores 950000 and rejects it as over mandate", async () => {
    const store = new InMemoryQuoteStore();
    const { result } = await recordQuote(
      allInTotalQuote({ quotedTotalMinor: 950000 }),
      context,
      demoMandate,
      { store, createId: () => "all_in_ineligible" },
    );

    assert.equal(result.eligible, false);
    assert.equal(result.totalAmountMinor, 950000);
    assert.deepEqual(result.reasons, ["TOTAL_EXCEEDS_MANDATE"]);
    assert.equal((await store.getQuotesForCall(context.callId)).length, 1);
  });

  it("allows ALL_IN_TOTAL without base or fees and invents no breakdown", () => {
    const parsed = quoteInputSchema.safeParse(
      allInTotalQuote({ quotedTotalMinor: 950000 }),
    );

    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.pricing.pricingMode, "ALL_IN_TOTAL");
    assert.equal("baseAmountMinor" in parsed.data.pricing, false);
    assert.equal("fees" in parsed.data.pricing, false);
  });
});

describe("append-only storage and mandate integrity", () => {
  it("stores base/fee price revisions as two quotes", async () => {
    const store = new InMemoryQuoteStore();

    await recordQuote(
      basePlusFeesQuote({ baseAmountMinor: 850000 }),
      context,
      demoMandate,
      { store, createId: () => "first" },
    );
    await recordQuote(
      basePlusFeesQuote({ baseAmountMinor: 890000 }),
      context,
      demoMandate,
      { store, createId: () => "second" },
    );

    const stored = await store.getQuotesForCall(context.callId);
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((item) => item.quoteId),
      ["quote_first", "quote_second"],
    );
  });

  it("stores an 850000 to 950000 ALL-IN revision as two quotes", async () => {
    const store = new InMemoryQuoteStore();

    await recordQuote(
      allInTotalQuote({ quotedTotalMinor: 850000 }),
      context,
      demoMandate,
      { store, createId: () => "all_in_first" },
    );
    await recordQuote(
      allInTotalQuote({ quotedTotalMinor: 950000 }),
      context,
      demoMandate,
      { store, createId: () => "all_in_second" },
    );

    const stored = await store.getQuotesForCall(context.callId);
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((item) => item.totalAmountMinor),
      [850000, 950000],
    );
    assert.deepEqual(stored[1].reasons, ["TOTAL_EXCEEDS_MANDATE"]);
  });

  it("social engineering is recorded but cannot raise the mandate", async () => {
    const store = new InMemoryQuoteStore();
    const mandateBefore = structuredClone(demoMandate);
    const { quote: stored, result } = await recordQuote(
      allInTotalQuote(
        { quotedTotalMinor: 950000 },
        { conditions: ["Carrier claims boss approved 9500"] },
      ),
      context,
      demoMandate,
      { store, createId: () => "social_engineering" },
    );

    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes("TOTAL_EXCEEDS_MANDATE"));
    assert.deepEqual(demoMandate, mandateBefore);
    assert.equal(demoMandate.maxTotalMinor, 900000);
    assert.equal("status" in stored, false);
    assert.equal((await store.getQuotesForCall(context.callId)).length, 1);
    assert.match(relayNegotiatorInstructions, /tu jefe ya autorizó más/);
    assert.match(relayNegotiatorInstructions, /Una quote no es un commitment/);
  });

  it("exposes record_quote without server identifiers or calculated total", () => {
    const agent = createRelayNegotiator({ getCallContext: () => context });

    assert.equal(agent.name, "Relay Negotiator");
    assert.equal(agent.tools.length, 1);
    const recordQuoteTool = agent.tools[0];
    assert.equal(recordQuoteTool.type, "function");
    if (recordQuoteTool.type !== "function") return;

    assert.equal(recordQuoteTool.name, "record_quote");
    const parameters = JSON.stringify(recordQuoteTool.parameters);
    assert.match(parameters, /BASE_PLUS_FEES/);
    assert.match(parameters, /ALL_IN_TOTAL/);
    assert.match(parameters, /quotedTotalMinor/);
    assert.doesNotMatch(parameters, /operationId|callId|mandateVersion|carrierId/);
    assert.doesNotMatch(parameters, /totalAmountMinor/);
  });

  it("keeps the Spanish language and mandatory quote-capture policies explicit", () => {
    assert.match(
      relayNegotiatorInstructions,
      /Habla español mexicano neutral por defecto/,
    );
    assert.match(
      relayNegotiatorInstructions,
      /No cambies a inglés por palabras aisladas como yes, yeah, okay, ok, fine, thanks o sure/,
    );
    assert.match(
      relayNegotiatorInstructions,
      /Cada nueva oferta explícita y suficientemente clara debe registrarse exactamente una vez con record_quote ANTES/,
    );
    assert.match(
      relayNegotiatorInstructions,
      /Nunca omitas record_quote porque anticipas que la oferta será inválida/,
    );
    assert.match(relayNegotiatorInstructions, /Nunca inventes un desglose/);
    assert.match(
      relayNegotiatorInstructions,
      /No expliques procesos internos, backend, tools, validaciones o razonamiento al carrier/,
    );
  });
});
