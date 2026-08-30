import twilio from "twilio";
import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";

export interface RecordingGateway {
  start(input: {
    callSid: string;
    statusCallbackUrl: string;
  }): Promise<{ recordingSid: string; status: string }>;
}

export class TwilioRecordingGateway implements RecordingGateway {
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async start(input: { callSid: string; statusCallbackUrl: string }) {
    const recording = await this.client.calls(input.callSid).recordings.create({
      recordingStatusCallback: input.statusCallbackUrl,
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
      recordingTrack: "both",
    });
    return { recordingSid: recording.sid, status: recording.status };
  }
}

export class DisabledRecordingGateway implements RecordingGateway {
  async start(): Promise<{ recordingSid: string; status: string }> {
    throw new ApiError(503, "RECORDING_NOT_CONFIGURED", "Recording de Twilio no está configurado.");
  }
}

export class RecordingService {
  private readonly starts = new Map<string, Promise<Awaited<ReturnType<CallsService["getById"]>>>>();

  constructor(
    private readonly callsService: CallsService,
    private readonly gateway: RecordingGateway,
    private readonly publicBaseUrl: string,
  ) {}

  async start(callId: string) {
    const active = this.starts.get(callId);
    if (active) return active;
    const start = this.startOnce(callId);
    this.starts.set(callId, start);
    try {
      return await start;
    } finally {
      if (this.starts.get(callId) === start) this.starts.delete(callId);
    }
  }

  private async startOnce(callId: string) {
    const call = await this.callsService.getById(callId);
    if (!call.twilioCallSid) {
      throw new ApiError(409, "CALL_PROVIDER_ID_REQUIRED", "Recording requiere CallSid real.");
    }
    if (call.recordingStatus !== null) return call;
    await this.callsService.updateRecording(callId, { recordingStatus: "REQUESTED" });
    const callback = new URL("/api/v1/webhooks/twilio/recording-status", this.publicBaseUrl);
    callback.searchParams.set("callId", callId);
    try {
      const result = await this.gateway.start({
        callSid: call.twilioCallSid,
        statusCallbackUrl: callback.toString(),
      });
      return this.receiveStatus({
        callId,
        callSid: call.twilioCallSid,
        recordingSid: result.recordingSid,
        status: result.status,
      });
    } catch (error) {
      await this.callsService.updateRecording(callId, { recordingStatus: "FAILED" });
      throw error;
    }
  }

  async receiveStatus(input: {
    callId: string;
    callSid: string;
    recordingSid: string;
    status: string;
    recordingUrl?: string;
    durationSeconds?: number;
  }) {
    const call = await this.callsService.getById(input.callId);
    if (call.twilioCallSid !== input.callSid) {
      throw new ApiError(409, "RECORDING_CALL_MISMATCH", "El callback de recording no corresponde al CallSid.");
    }
    const owner = await this.callsService.findByRecordingSid(input.recordingSid);
    if (owner && owner.id !== call.id) {
      throw new ApiError(409, "RECORDING_CALL_MISMATCH", "El RecordingSid pertenece a otra llamada.");
    }
    if (call.recordingSid && call.recordingSid !== input.recordingSid) {
      throw new ApiError(409, "RECORDING_SID_CONFLICT", "La llamada ya tiene otro RecordingSid.");
    }
    const nextStatus = normalizeStatus(input.status);
    if (statusRank(nextStatus) < statusRank(call.recordingStatus)) return call;
    if (
      call.recordingSid === input.recordingSid &&
      call.recordingStatus === nextStatus &&
      call.recordingUrl === (input.recordingUrl ?? call.recordingUrl) &&
      call.recordingDurationSeconds === (input.durationSeconds ?? call.recordingDurationSeconds)
    ) return call;
    return this.callsService.updateRecording(call.id, {
      recordingSid: input.recordingSid,
      recordingStatus: nextStatus,
      ...(input.recordingUrl ? { recordingUrl: input.recordingUrl } : {}),
      ...(input.durationSeconds === undefined ? {} : { recordingDurationSeconds: input.durationSeconds }),
    });
  }
}

function normalizeStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "in-progress" || normalized === "processing") return "IN_PROGRESS";
  if (normalized === "completed") return "COMPLETED";
  if (normalized === "absent") return "ABSENT";
  if (normalized === "failed") return "FAILED";
  return normalized.toUpperCase().replaceAll("-", "_");
}

function statusRank(status: string | null): number {
  return ({ REQUESTED: 1, IN_PROGRESS: 2, COMPLETED: 3, ABSENT: 3, FAILED: 3 } as Record<string, number>)[status ?? ""] ?? 0;
}
