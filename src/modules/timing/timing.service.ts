import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { callTimingEvents } from "../../db/schema";
import type * as databaseSchema from "../../db/schema";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";

export type TimingClock = "twilio_stream" | "openai_input" | "recording" | "local_observation";

export interface TimingEvent {
  id: string;
  callId: string;
  streamSid: string | null;
  clock: TimingClock;
  eventType: string;
  rawTimestampMs: number;
  itemId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface TimingRepository {
  insert(event: TimingEvent): Promise<void>;
  list(callId: string): Promise<TimingEvent[]>;
}

export class InMemoryTimingRepository implements TimingRepository {
  private readonly events: TimingEvent[] = [];
  async insert(event: TimingEvent) { this.events.push(structuredClone(event)); }
  async list(callId: string) { return this.events.filter((event) => event.callId === callId).map((event) => structuredClone(event)); }
}

type VoiceDatabase = BetterSQLite3Database<typeof databaseSchema>;
export class DrizzleTimingRepository implements TimingRepository {
  constructor(private readonly database: VoiceDatabase) {}
  async insert(event: TimingEvent) {
    this.database.insert(callTimingEvents).values({
      id: event.id,
      callId: event.callId,
      streamSid: event.streamSid,
      clock: event.clock,
      eventType: event.eventType,
      rawTimestampMs: event.rawTimestampMs,
      itemId: event.itemId,
      metadataJson: event.metadata ? JSON.stringify(event.metadata) : null,
      createdAt: event.createdAt,
    }).run();
  }
  async list(callId: string) {
    return this.database.select().from(callTimingEvents).where(eq(callTimingEvents.callId, callId)).all().map((row) => ({
      id: row.id,
      callId: row.callId,
      streamSid: row.streamSid,
      clock: row.clock as TimingClock,
      eventType: row.eventType,
      rawTimestampMs: row.rawTimestampMs,
      itemId: row.itemId,
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) as Record<string, unknown> : null,
      createdAt: row.createdAt,
    }));
  }
}

export class TimingService {
  constructor(
    private readonly callsService: CallsService,
    private readonly repository: TimingRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: {
    callId: string;
    streamSid?: string | null;
    clock: TimingClock;
    eventType: string;
    rawTimestampMs: number;
    itemId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    const call = await this.callsService.getById(input.callId);
    if (input.streamSid && call.twilioStreamSid !== input.streamSid) {
      throw new ApiError(409, "TIMING_STREAM_MISMATCH", "El evento timing no corresponde al StreamSid de la llamada.");
    }
    await this.repository.insert({
      id: `tim_${randomUUID()}`,
      callId: input.callId,
      streamSid: input.streamSid ?? null,
      clock: input.clock,
      eventType: input.eventType,
      rawTimestampMs: input.rawTimestampMs,
      itemId: input.itemId ?? null,
      metadata: input.metadata ?? null,
      createdAt: this.now().toISOString(),
    });
  }

  async list(callId: string): Promise<TimingEvent[]> {
    await this.callsService.getById(callId);
    return this.repository.list(callId);
  }
}
