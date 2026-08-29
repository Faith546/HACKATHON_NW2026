import type { RealtimeSession } from "./realtime.types";

export interface RealtimeSessionRepository {
  insert(session: RealtimeSession): Promise<void>;
  findById(sessionId: string): Promise<RealtimeSession | null>;
  findActiveByCallId(callId: string): Promise<RealtimeSession | null>;
  save(session: RealtimeSession): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class InMemoryRealtimeSessionRepository
  implements RealtimeSessionRepository
{
  private readonly sessions = new Map<string, RealtimeSession>();

  async insert(session: RealtimeSession): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(`Realtime session ${session.id} already exists`);
    }
    this.sessions.set(session.id, structuredClone(session));
  }

  async findById(sessionId: string): Promise<RealtimeSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async findActiveByCallId(callId: string): Promise<RealtimeSession | null> {
    for (const session of this.sessions.values()) {
      if (session.callId === callId && session.status === "ACTIVE") {
        return structuredClone(session);
      }
    }
    return null;
  }

  async save(session: RealtimeSession): Promise<void> {
    if (!this.sessions.has(session.id)) {
      throw new Error(`Realtime session ${session.id} does not exist`);
    }
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
