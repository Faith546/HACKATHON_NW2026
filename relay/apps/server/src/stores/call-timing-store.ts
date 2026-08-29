import type { CallTiming, CallerSpeechRange } from "../domain/timing.js";

type MediaMetadata = {
  streamSid: string;
  timestamp: unknown;
  sequenceNumber?: unknown;
  chunk?: unknown;
  track?: unknown;
};

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function clone(timing: CallTiming): CallTiming {
  return structuredClone(timing);
}

export class CallTimingStore {
  private readonly byCallId = new Map<string, CallTiming>();
  private readonly callIdByStreamSid = new Map<string, string>();

  startStream(callId: string, streamSid: string): CallTiming {
    const existing = this.byCallId.get(callId);
    if (existing && existing.stream.streamSid !== streamSid) {
      throw new Error(`CallSid ${callId} is already linked to another StreamSid`);
    }

    const streamOwner = this.callIdByStreamSid.get(streamSid);
    if (streamOwner && streamOwner !== callId) {
      throw new Error(`StreamSid ${streamSid} is already linked to another CallSid`);
    }

    const timing: CallTiming =
      existing ?? {
        callId,
        stream: { clock: "twilio_stream", streamSid },
        callerSpeechRanges: [],
      };

    this.byCallId.set(callId, timing);
    this.callIdByStreamSid.set(streamSid, callId);
    return clone(timing);
  }

  observeMedia(metadata: MediaMetadata): boolean {
    const timestamp = parseNonNegativeInteger(metadata.timestamp);
    if (timestamp === undefined) return false;

    const callId = this.callIdByStreamSid.get(metadata.streamSid);
    if (!callId) return false;
    const timing = this.byCallId.get(callId);
    if (!timing) return false;

    const stream = timing.stream;
    stream.firstMediaTimestampMs =
      stream.firstMediaTimestampMs === undefined
        ? timestamp
        : Math.min(stream.firstMediaTimestampMs, timestamp);
    stream.lastMediaTimestampMs =
      stream.lastMediaTimestampMs === undefined
        ? timestamp
        : Math.max(stream.lastMediaTimestampMs, timestamp);

    const sequenceNumber = parseNonNegativeInteger(metadata.sequenceNumber);
    if (sequenceNumber !== undefined) {
      stream.firstSequenceNumber =
        stream.firstSequenceNumber === undefined
          ? sequenceNumber
          : Math.min(stream.firstSequenceNumber, sequenceNumber);
      stream.lastSequenceNumber =
        stream.lastSequenceNumber === undefined
          ? sequenceNumber
          : Math.max(stream.lastSequenceNumber, sequenceNumber);
    }

    const chunk = parseNonNegativeInteger(metadata.chunk);
    if (chunk !== undefined) {
      stream.firstChunk =
        stream.firstChunk === undefined
          ? chunk
          : Math.min(stream.firstChunk, chunk);
      stream.lastChunk =
        stream.lastChunk === undefined
          ? chunk
          : Math.max(stream.lastChunk, chunk);
    }

    if (typeof metadata.track === "string") stream.lastTrack = metadata.track;
    return true;
  }

  observeSpeechStarted(
    callId: string,
    itemId: string,
    startMsValue: unknown,
  ): boolean {
    const startMs = parseNonNegativeInteger(startMsValue);
    const timing = this.byCallId.get(callId);
    if (startMs === undefined || !timing || !itemId) return false;

    const range = this.findOrCreateSpeechRange(timing, itemId);
    if (range.endMs !== undefined && startMs > range.endMs) return false;
    range.startMs = startMs;
    return true;
  }

  observeSpeechStopped(
    callId: string,
    itemId: string,
    endMsValue: unknown,
  ): boolean {
    const endMs = parseNonNegativeInteger(endMsValue);
    const timing = this.byCallId.get(callId);
    if (endMs === undefined || !timing || !itemId) return false;

    const range = this.findOrCreateSpeechRange(timing, itemId);
    if (range.startMs !== undefined && endMs < range.startMs) return false;
    range.endMs = endMs;
    return true;
  }

  getByCallId(callId: string): CallTiming | undefined {
    const timing = this.byCallId.get(callId);
    return timing ? clone(timing) : undefined;
  }

  getByStreamSid(streamSid: string): CallTiming | undefined {
    const callId = this.callIdByStreamSid.get(streamSid);
    return callId ? this.getByCallId(callId) : undefined;
  }

  private findOrCreateSpeechRange(
    timing: CallTiming,
    itemId: string,
  ): CallerSpeechRange {
    let range = timing.callerSpeechRanges.find(
      (candidate) => candidate.itemId === itemId,
    );
    if (!range) {
      range = { clock: "openai_input", itemId };
      timing.callerSpeechRanges.push(range);
    }
    return range;
  }
}

export const callTimingStore = new CallTimingStore();
