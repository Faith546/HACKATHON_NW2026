import type { CallContext } from "../domain/call-context.js";

export type StartCallContext = Omit<CallContext, "startedAt"> & {
  startedAt?: string;
};

export class InMemoryCallContextStore {
  private readonly calls = new Map<string, CallContext>();

  startCall(input: StartCallContext): CallContext {
    const existing = this.calls.get(input.callId);
    const context: CallContext = {
      ...(existing ?? {
        callId: input.callId,
        operationId: input.operationId,
        mandateVersion: input.mandateVersion,
        startedAt: input.startedAt ?? new Date().toISOString(),
      }),
      ...(input.streamSid ? { streamSid: input.streamSid } : {}),
      ...(input.carrierId ? { carrierId: input.carrierId } : {}),
    };

    this.calls.set(context.callId, context);
    return structuredClone(context);
  }

  get(callId: string): CallContext | undefined {
    const context = this.calls.get(callId);
    return context ? structuredClone(context) : undefined;
  }

  getLatest(): CallContext | undefined {
    let latest: CallContext | undefined;

    for (const context of this.calls.values()) {
      if (
        !latest ||
        context.startedAt > latest.startedAt ||
        (context.startedAt === latest.startedAt && context.callId > latest.callId)
      ) {
        latest = context;
      }
    }

    return latest ? structuredClone(latest) : undefined;
  }
}

export const callContextStore = new InMemoryCallContextStore();
