import { randomUUID } from "node:crypto";
import type { CallContext } from "../domain/call-context.js";
import type { Mandate } from "../domain/mandate.js";
import type {
  Quote,
  QuoteInput,
  QuoteValidationReason,
  QuoteValidationResult,
  RecordQuoteResult,
} from "../domain/quote.js";
import type { QuoteStore } from "../stores/quote-store.js";

function addReason(
  reasons: QuoteValidationReason[],
  reason: QuoteValidationReason,
) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function validateQuote(
  input: QuoteInput,
  mandate: Mandate,
): QuoteValidationResult {
  const reasons: QuoteValidationReason[] = [];
  const totalAmountMinor =
    input.pricing.pricingMode === "ALL_IN_TOTAL"
      ? input.pricing.quotedTotalMinor
      : input.pricing.baseAmountMinor === null
        ? null
        : input.pricing.baseAmountMinor +
          input.pricing.fees.reduce((sum, fee) => sum + fee.amountMinor, 0);

  if (
    input.pricing.pricingMode === "BASE_PLUS_FEES" &&
    input.pricing.baseAmountMinor === null
  ) {
    addReason(reasons, "MISSING_PRICE");
  }

  const { pickupDate, pickupWindowStart, pickupWindowEnd } = input;

  if (
    pickupDate === null ||
    pickupWindowStart === null ||
    pickupWindowEnd === null
  ) {
    addReason(reasons, "MISSING_PICKUP");
  } else if (
    pickupDate !== mandate.pickup.date ||
    pickupWindowStart < mandate.pickup.windowStart ||
    pickupWindowEnd > mandate.pickup.windowEnd ||
    pickupWindowStart > pickupWindowEnd
  ) {
    addReason(reasons, "PICKUP_OUTSIDE_WINDOW");
  }

  if (input.currency.toUpperCase() !== mandate.currency) {
    addReason(reasons, "WRONG_CURRENCY");
  }

  if (totalAmountMinor !== null && totalAmountMinor > mandate.maxTotalMinor) {
    addReason(reasons, "TOTAL_EXCEEDS_MANDATE");
  }

  if (mandate.allInRequired && !input.allInConfirmed) {
    addReason(reasons, "ALL_IN_NOT_CONFIRMED");
  }

  return {
    eligible: reasons.length === 0,
    totalAmountMinor,
    reasons,
  };
}

export type RecordQuoteDependencies = {
  store: QuoteStore;
  now?: () => Date;
  createId?: () => string;
};

export async function recordQuote(
  input: QuoteInput,
  context: CallContext,
  mandate: Mandate,
  dependencies: RecordQuoteDependencies,
): Promise<{ quote: Quote; result: RecordQuoteResult }> {
  if (
    context.operationId !== mandate.operationId ||
    context.mandateVersion !== mandate.version
  ) {
    throw new Error("Call context does not match the active mandate");
  }

  const validation = validateQuote(input, mandate);
  const quoteId = `quote_${dependencies.createId?.() ?? randomUUID()}`;
  const quote: Quote = {
    ...input,
    ...validation,
    quoteId,
    operationId: context.operationId,
    callId: context.callId,
    mandateVersion: context.mandateVersion,
    ...(context.carrierId ? { carrierId: context.carrierId } : {}),
    createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };

  await dependencies.store.saveQuote(quote);

  return {
    quote,
    result: {
      ok: true,
      quoteId,
      ...validation,
    },
  };
}
