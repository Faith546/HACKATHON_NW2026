import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { calls as callsTable } from "../../db/schema";
import type * as databaseSchema from "../../db/schema";
import type {
  Call,
  CallActorType,
  CallBrief,
  CallPurpose,
  CallStatus,
} from "./calls.types";

export interface CallStatusTransition {
  expectedStatus: CallStatus;
  status: CallStatus;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface CallTransitionResult {
  call: Call;
  changed: boolean;
}

export interface CallRepository {
  insert(call: Call): Promise<void>;
  findById(callId: string): Promise<Call | null>;
  findByProviderCallId(providerCallId: string): Promise<Call | null>;
  findByStreamSid(streamSid: string): Promise<Call | null>;
  findByRecordingSid(recordingSid: string): Promise<Call | null>;
  findByOperationPurpose(
    operationId: string,
    purpose: CallPurpose,
  ): Promise<Call | null>;
  setProviderCallId(callId: string, providerCallId: string): Promise<Call>;
  setStreamSid(callId: string, streamSid: string): Promise<Call>;
  setRecording(callId: string, patch: {
    recordingSid?: string | null;
    recordingStatus?: string | null;
    recordingUrl?: string | null;
    recordingDurationSeconds?: number | null;
  }): Promise<Call>;
  bindContext(
    callId: string,
    input: {
      operationId: string;
      purpose?: CallPurpose;
      actorType?: CallActorType;
    },
  ): Promise<Call>;
  setRealtimeSessionId(callId: string, sessionId: string | null): Promise<Call>;
  saveTranscript(callId: string, transcript: string): Promise<Call>;
  setStatus(
    callId: string,
    status: CallStatus,
    endedAt?: string | null,
  ): Promise<Call>;
  transitionStatusByProviderCallId(
    providerCallId: string,
    transition: CallStatusTransition,
  ): Promise<CallTransitionResult | null>;
  saveBrief(callId: string, brief: CallBrief): Promise<CallBrief>;
}

function cloneCall(call: Call): Call {
  return structuredClone(call);
}

export class InMemoryCallRepository implements CallRepository {
  private readonly callsById = new Map<string, Call>();

  async insert(call: Call): Promise<void> {
    if (this.callsById.has(call.id)) {
      throw new Error(`Call ${call.id} already exists`);
    }
    this.callsById.set(call.id, cloneCall(call));
  }

  async findById(callId: string): Promise<Call | null> {
    const call = this.callsById.get(callId);
    return call ? cloneCall(call) : null;
  }

  async findByProviderCallId(providerCallId: string): Promise<Call | null> {
    for (const call of this.callsById.values()) {
      if (call.twilioCallSid === providerCallId) return cloneCall(call);
    }
    return null;
  }

  async findByStreamSid(streamSid: string): Promise<Call | null> {
    for (const call of this.callsById.values()) {
      if (call.twilioStreamSid === streamSid) return cloneCall(call);
    }
    return null;
  }

  async findByRecordingSid(recordingSid: string): Promise<Call | null> {
    for (const call of this.callsById.values()) {
      if (call.recordingSid === recordingSid) return cloneCall(call);
    }
    return null;
  }

  async findByOperationPurpose(
    operationId: string,
    purpose: CallPurpose,
  ): Promise<Call | null> {
    for (const call of this.callsById.values()) {
      if (call.operationId === operationId && call.purpose === purpose) {
        return cloneCall(call);
      }
    }
    return null;
  }

  async setProviderCallId(
    callId: string,
    providerCallId: string,
  ): Promise<Call> {
    return this.update(callId, { twilioCallSid: providerCallId });
  }

  async setStreamSid(callId: string, streamSid: string): Promise<Call> {
    const owner = await this.findByStreamSid(streamSid);
    if (owner && owner.id !== callId) throw new Error("StreamSid already exists");
    return this.update(callId, { twilioStreamSid: streamSid });
  }

  async setRecording(callId: string, patch: Parameters<CallRepository["setRecording"]>[1]): Promise<Call> {
    return this.update(callId, patch);
  }

  async bindContext(
    callId: string,
    input: {
      operationId: string;
      purpose?: CallPurpose;
      actorType?: CallActorType;
    },
  ): Promise<Call> {
    return this.update(callId, input);
  }

  async setRealtimeSessionId(
    callId: string,
    sessionId: string | null,
  ): Promise<Call> {
    return this.update(callId, { realtimeSessionId: sessionId });
  }

  async saveTranscript(callId: string, transcript: string): Promise<Call> {
    return this.update(callId, { transcript });
  }

  async setStatus(
    callId: string,
    status: CallStatus,
    endedAt?: string | null,
  ): Promise<Call> {
    return this.update(callId, {
      status,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
  }

  async transitionStatusByProviderCallId(
    providerCallId: string,
    transition: CallStatusTransition,
  ): Promise<CallTransitionResult | null> {
    const stored = [...this.callsById.values()].find(
      (call) => call.twilioCallSid === providerCallId,
    );
    const current = stored ? cloneCall(stored) : null;
    if (!current) return null;
    if (current.status !== transition.expectedStatus) {
      return { call: current, changed: false };
    }
    if (
      current.status === transition.status &&
      (transition.startedAt === undefined ||
        current.startedAt === transition.startedAt) &&
      (transition.endedAt === undefined || current.endedAt === transition.endedAt)
    ) {
      return { call: current, changed: false };
    }

    const call = await this.update(current.id, {
      status: transition.status,
      ...(transition.startedAt === undefined
        ? {}
        : { startedAt: transition.startedAt }),
      ...(transition.endedAt === undefined ? {} : { endedAt: transition.endedAt }),
    });
    return { call, changed: true };
  }

  async saveBrief(callId: string, brief: CallBrief): Promise<CallBrief> {
    await this.update(callId, { brief });
    return structuredClone(brief);
  }

  private async update(callId: string, patch: Partial<Call>): Promise<Call> {
    const current = this.callsById.get(callId);
    if (!current) throw new Error(`Call ${callId} does not exist`);

    const updated = { ...current, ...structuredClone(patch) };
    this.callsById.set(callId, updated);
    return cloneCall(updated);
  }
}

type VoiceDatabase = BetterSQLite3Database<typeof databaseSchema>;
type CallRow = typeof callsTable.$inferSelect;

function parseBrief(raw: string | null): CallBrief | null {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    !("callId" in value) ||
    !("summary" in value) ||
    !("outcome" in value) ||
    !("generatedAt" in value)
  ) {
    throw new Error("Stored call brief is invalid");
  }
  return value as CallBrief;
}

function toCall(row: CallRow): Call {
  if (row.operationId === null) {
    throw new Error(`Call ${row.id} has no operation context`);
  }
  return {
    id: row.id,
    operationId: row.operationId,
    carrierId: row.carrierId,
    negotiationId: row.negotiationId,
    actorType: row.actorType as CallActorType,
    twilioCallSid: row.twilioCallSid,
    twilioStreamSid: row.twilioStreamSid,
    recordingSid: row.recordingSid,
    recordingStatus: row.recordingStatus,
    recordingUrl: row.recordingUrl,
    recordingDurationSeconds: row.recordingDurationSeconds,
    realtimeSessionId: row.realtimeSessionId,
    direction: row.direction as Call["direction"],
    purpose: row.purpose as Call["purpose"],
    status: row.status as CallStatus,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    transcript: row.transcriptText,
    brief: parseBrief(row.briefJson),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleCallRepository implements CallRepository {
  constructor(private readonly database: VoiceDatabase) {}

  async insert(call: Call): Promise<void> {
    this.database.insert(callsTable).values({
      id: call.id,
      operationId: call.operationId,
      carrierId: call.carrierId,
      negotiationId: call.negotiationId,
      actorType: call.actorType,
      twilioCallSid: call.twilioCallSid,
      twilioStreamSid: call.twilioStreamSid,
      recordingSid: call.recordingSid,
      recordingStatus: call.recordingStatus,
      recordingUrl: call.recordingUrl,
      recordingDurationSeconds: call.recordingDurationSeconds,
      realtimeSessionId: call.realtimeSessionId,
      direction: call.direction,
      purpose: call.purpose,
      status: call.status,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      transcriptText: call.transcript,
      briefJson: call.brief ? JSON.stringify(call.brief) : null,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      createdAt: call.createdAt,
    }).run();
  }

  async findById(callId: string): Promise<Call | null> {
    const row = this.database
      .select()
      .from(callsTable)
      .where(eq(callsTable.id, callId))
      .get();
    return row ? toCall(row) : null;
  }

  async findByProviderCallId(providerCallId: string): Promise<Call | null> {
    const row = this.database
      .select()
      .from(callsTable)
      .where(eq(callsTable.twilioCallSid, providerCallId))
      .get();
    return row ? toCall(row) : null;
  }

  async findByStreamSid(streamSid: string): Promise<Call | null> {
    const row = this.database
      .select()
      .from(callsTable)
      .where(eq(callsTable.twilioStreamSid, streamSid))
      .get();
    return row ? toCall(row) : null;
  }

  async findByRecordingSid(recordingSid: string): Promise<Call | null> {
    const row = this.database
      .select()
      .from(callsTable)
      .where(eq(callsTable.recordingSid, recordingSid))
      .get();
    return row ? toCall(row) : null;
  }

  async findByOperationPurpose(
    operationId: string,
    purpose: CallPurpose,
  ): Promise<Call | null> {
    const row = this.database
      .select()
      .from(callsTable)
      .where(
        and(
          eq(callsTable.operationId, operationId),
          eq(callsTable.purpose, purpose),
        ),
      )
      .orderBy(callsTable.createdAt)
      .limit(1)
      .get();
    return row ? toCall(row) : null;
  }

  async setProviderCallId(
    callId: string,
    providerCallId: string,
  ): Promise<Call> {
    return this.update(callId, { twilioCallSid: providerCallId });
  }

  async setStreamSid(callId: string, streamSid: string): Promise<Call> {
    return this.update(callId, { twilioStreamSid: streamSid });
  }

  async setRecording(callId: string, patch: Parameters<CallRepository["setRecording"]>[1]): Promise<Call> {
    return this.update(callId, patch);
  }

  async bindContext(
    callId: string,
    input: {
      operationId: string;
      purpose?: CallPurpose;
      actorType?: CallActorType;
    },
  ): Promise<Call> {
    return this.update(callId, input);
  }

  async setRealtimeSessionId(
    callId: string,
    sessionId: string | null,
  ): Promise<Call> {
    return this.update(callId, { realtimeSessionId: sessionId });
  }

  async saveTranscript(callId: string, transcript: string): Promise<Call> {
    return this.update(callId, { transcriptText: transcript });
  }

  async setStatus(
    callId: string,
    status: CallStatus,
    endedAt?: string | null,
  ): Promise<Call> {
    return this.update(callId, {
      status,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
  }

  async transitionStatusByProviderCallId(
    providerCallId: string,
    transition: CallStatusTransition,
  ): Promise<CallTransitionResult | null> {
    const row = this.database
      .update(callsTable)
      .set({
        status: transition.status,
        ...(transition.startedAt === undefined
          ? {}
          : { startedAt: transition.startedAt }),
        ...(transition.endedAt === undefined
          ? {}
          : { endedAt: transition.endedAt }),
      })
      .where(
        and(
          eq(callsTable.twilioCallSid, providerCallId),
          eq(callsTable.status, transition.expectedStatus),
        ),
      )
      .returning()
      .get();
    if (row) return { call: toCall(row), changed: true };
    const current = await this.findByProviderCallId(providerCallId);
    return current ? { call: current, changed: false } : null;
  }

  async saveBrief(callId: string, brief: CallBrief): Promise<CallBrief> {
    await this.update(callId, { briefJson: JSON.stringify(brief) });
    return structuredClone(brief);
  }

  private async update(
    callId: string,
    patch: Partial<typeof callsTable.$inferInsert>,
  ): Promise<Call> {
    const row = this.database
      .update(callsTable)
      .set(patch)
      .where(eq(callsTable.id, callId))
      .returning()
      .get();
    if (!row) throw new Error(`Call ${callId} does not exist`);
    return toCall(row);
  }
}
