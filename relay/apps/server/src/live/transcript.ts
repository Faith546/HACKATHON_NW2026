import { EventEmitter } from "node:events";

export type TranscriptSpeaker = "caller" | "relay";

export type TranscriptTurn = {
  callId: string;
  turnId: string;
  speaker: TranscriptSpeaker;
  text: string;
  final: boolean;
  timestampMs: number;
  interrupted: boolean;
};

class TranscriptBus extends EventEmitter {
  private readonly turnsByCall = new Map<string, TranscriptTurn[]>();

  publish(turn: TranscriptTurn) {
    const current = this.turnsByCall.get(turn.callId) ?? [];
    const index = current.findIndex((item) => item.turnId === turn.turnId);
    const previous = index >= 0 ? current[index] : undefined;
    const next = {
      ...previous,
      ...turn,
      interrupted: turn.interrupted || previous?.interrupted || false,
    };

    if (
      previous &&
      previous.speaker === next.speaker &&
      previous.text === next.text &&
      previous.final === next.final &&
      previous.timestampMs === next.timestampMs &&
      previous.interrupted === next.interrupted
    ) {
      return;
    }

    if (index >= 0) {
      current[index] = next;
    } else {
      current.push(next);
    }

    this.turnsByCall.set(turn.callId, current);
    this.emit(`call:${turn.callId}`, structuredClone(next));
  }

  getSnapshot(callId: string): TranscriptTurn[] {
    return (this.turnsByCall.get(callId) ?? []).map((turn) =>
      structuredClone(turn),
    );
  }

  markLatestRelayInterrupted(callId: string) {
    const turns = this.turnsByCall.get(callId) ?? [];

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn.speaker !== "relay" || turn.final) continue;

      this.publish({ ...turn, interrupted: true, final: true });
      return;
    }
  }

  clear(callId: string) {
    this.turnsByCall.delete(callId);
  }
}

export const transcriptBus = new TranscriptBus();
