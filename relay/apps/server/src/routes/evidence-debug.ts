import type { FastifyPluginAsync } from "fastify";
import { transcriptBus } from "../live/transcript.js";
import { correlateRecording } from "../services/recording-correlation.js";
import { callContextStore } from "../stores/call-context-store.js";
import { callTimingStore } from "../stores/call-timing-store.js";
import { recordingStore } from "../stores/recording-store.js";

type CallParams = { callId: string };

export function buildEvidenceDebug(callId: string) {
  const timing = callTimingStore.getByCallId(callId);
  const recording = recordingStore.getByCallId(callId);

  return {
    callId,
    transcript: {
      clock: "local_observation" as const,
      evidenceEligible: false,
      turns: transcriptBus.getSnapshot(callId),
    },
    timing: timing ?? null,
    recording: recording ?? null,
    correlation: correlateRecording({ callId, timing, recording }),
  };
}

const evidenceDebugRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/debug/calls/latest", async (_request, reply) => {
    const context = callContextStore.getLatest();
    if (!context) {
      return reply.code(404).send({ error: "NO_CALLS_FOUND" });
    }

    const recording = recordingStore.getByCallId(context.callId);
    return {
      callId: context.callId,
      streamSid: context.streamSid ?? null,
      recordingSid: recording?.recordingSid ?? null,
      recordingStatus: recording?.status ?? null,
    };
  });

  app.get<{ Params: CallParams }>(
    "/api/calls/:callId/recording",
    async (request) => ({
      callId: request.params.callId,
      recording: recordingStore.getByCallId(request.params.callId) ?? null,
    }),
  );

  app.get<{ Params: CallParams }>(
    "/api/calls/:callId/timing",
    async (request) => ({
      callId: request.params.callId,
      timing: callTimingStore.getByCallId(request.params.callId) ?? null,
    }),
  );

  app.get<{ Params: CallParams }>(
    "/api/calls/:callId/evidence-debug",
    async (request) => buildEvidenceDebug(request.params.callId),
  );
};

export default evidenceDebugRoutes;
