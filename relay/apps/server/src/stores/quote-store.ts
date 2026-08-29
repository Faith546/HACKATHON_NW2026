import type { Quote } from "../domain/quote.js";

export interface QuoteStore {
  saveQuote(quote: Quote): Promise<void>;
  getQuotesForCall(callId: string): Promise<Quote[]>;
  getQuotesForOperation(operationId: string): Promise<Quote[]>;
}

// TEMPORARY SPIKE STORE. It is append-only but process-local and intentionally
// loses data on restart. Replace this implementation with Postgres later.
export class InMemoryQuoteStore implements QuoteStore {
  private readonly quotes: Quote[] = [];

  async saveQuote(quote: Quote): Promise<void> {
    if (this.quotes.some((candidate) => candidate.quoteId === quote.quoteId)) {
      throw new Error(`Quote already exists: ${quote.quoteId}`);
    }

    this.quotes.push(structuredClone(quote));
  }

  async getQuotesForCall(callId: string): Promise<Quote[]> {
    return this.quotes
      .filter((quote) => quote.callId === callId)
      .map((quote) => structuredClone(quote));
  }

  async getQuotesForOperation(operationId: string): Promise<Quote[]> {
    return this.quotes
      .filter((quote) => quote.operationId === operationId)
      .map((quote) => structuredClone(quote));
  }
}

export const quoteStore = new InMemoryQuoteStore();
