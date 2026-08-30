import { ApiError } from "../../shared/http/api-error";
import type { RealtimeSession, TranscriptSegment } from "./realtime.types";

export interface CallerMoneyEvidence {
  callerItemId: string;
  transcript: string;
  startMs: number;
  endMs: number;
  amountCents: number;
  currency: string;
  provenance: "CALLER_AUDIO_FINAL_TRANSCRIPT";
}

const smallNumbers: Record<string, number> = {
  cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4,
  cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300,
  cuatrocientos: 400, quinientos: 500, seiscientos: 600,
  setecientos: 700, ochocientos: 800, novecientos: 900,
};

export function requireCallerMoneyEvidence(
  session: RealtimeSession,
  totalPrice: number,
  currency: string,
): CallerMoneyEvidence {
  const expectedCents = Math.round(totalPrice * 100);
  const matching = [...session.transcriptSegments]
    .filter(isCallerAudioFact)
    .sort((left, right) => right.endMs - left.endMs)
    .find((segment) =>
      mentionsCurrency(segment.text, currency) &&
      extractAmounts(segment.text).some(
        (amount) => Math.round(amount * 100) === expectedCents,
      ),
    );
  if (!matching) {
    throw new ApiError(
      422,
      "UNGROUNDED_CALLER_MONEY",
      "El monto no aparece en audio finalizado del carrier para esta llamada.",
      { callId: session.callId, amountCents: expectedCents, currency },
    );
  }
  return {
    callerItemId: matching.id,
    transcript: matching.text,
    startMs: matching.startMs,
    endMs: matching.endMs,
    amountCents: expectedCents,
    currency: currency.toUpperCase(),
    provenance: "CALLER_AUDIO_FINAL_TRANSCRIPT",
  };
}

function isCallerAudioFact(segment: TranscriptSegment): boolean {
  return segment.speaker === "HUMAN" &&
    segment.source === "CALLER_AUDIO" &&
    segment.final &&
    !segment.interrupted;
}

function mentionsCurrency(text: string, currency: string): boolean {
  const normalized = normalize(text);
  const code = currency.toLowerCase();
  if (code === "mxn") return /\b(mxn|peso|pesos)\b/.test(normalized);
  if (code === "usd") return /\b(usd|dolar|dolares|dollar|dollars)\b/.test(normalized);
  return normalized.includes(code);
}

function extractAmounts(text: string): number[] {
  const normalized = normalize(text);
  const numeric = [...normalized.matchAll(/\b\d{1,3}(?:[ ,.']\d{3})+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})?\b/g)]
    .map((match) => parseNumeric(match[0]))
    .filter((value): value is number => value !== null);
  const wordValue = parseSpanishNumberWords(normalized);
  return wordValue === null ? numeric : [...numeric, wordValue];
}

function parseNumeric(raw: string): number | null {
  const compact = raw.replace(/[ ']/g, "");
  let canonical = compact;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(compact)) {
    canonical = compact.replace(/,/g, "");
  } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(compact)) {
    canonical = compact.replace(/\./g, "").replace(",", ".");
  } else {
    canonical = compact.replace(",", ".");
  }
  const value = Number(canonical);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseSpanishNumberWords(text: string): number | null {
  const tokens = text.split(/[^a-z]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let sawNumber = false;
  for (const token of tokens) {
    if (token === "y") continue;
    if (token === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      sawNumber = true;
      continue;
    }
    const value = smallNumbers[token];
    if (value === undefined) continue;
    current += value;
    sawNumber = true;
  }
  const value = total + current;
  return sawNumber && value > 0 ? value : null;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
