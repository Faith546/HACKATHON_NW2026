import { ApiError } from "../../shared/http/api-error";
import type { CallsService } from "../calls/calls.service";
import type { CallStatus } from "../calls/calls.types";
import { createMediaStreamTwiml } from "../calls/twilio-twiml";
import type { VoiceCorePort } from "../voice/voice-core.port";
import type {
  TwilioSignatureValidator,
  TwilioStatusWebhook,
  TwilioVoiceWebhook,
  TwilioWebhookRequest,
} from "./webhooks.types";

const statusMap: Record<string, CallStatus> = {
  queued: "QUEUED",
  initiated: "QUEUED",
  ringing: "RINGING",
  answered: "IN_PROGRESS",
  "in-progress": "IN_PROGRESS",
  completed: "COMPLETED",
  busy: "BUSY",
  "no-answer": "NO_ANSWER",
  failed: "FAILED",
  canceled: "FAILED",
};

export interface WebhooksServiceDependencies {
  callsService: CallsService;
  voiceCore: VoiceCorePort;
  signatureValidator: TwilioSignatureValidator;
  publicWssUrl: string;
  requireValidSignature?: boolean;
}

export class WebhooksService {
  constructor(private readonly dependencies: WebhooksServiceDependencies) {}

  async receiveVoice(
    body: TwilioVoiceWebhook,
    request: TwilioWebhookRequest,
  ): Promise<string> {
    this.validateSignature(request);
    const existing = await this.dependencies.callsService.findByProviderCallId(
      body.CallSid,
    );
    const call =
      existing ??
      (await this.createInboundCall(body));
    const streamUrl = new URL(this.dependencies.publicWssUrl);
    if (streamUrl.protocol !== "wss:") {
      throw new ApiError(
        503,
        "REALTIME_NOT_CONFIGURED",
        "PUBLIC_WSS_URL debe usar wss.",
      );
    }
    streamUrl.pathname = "/ws/twilio-media";
    streamUrl.search = "";
    streamUrl.hash = "";
    return createMediaStreamTwiml({
      streamUrl: streamUrl.toString(),
      callId: call.id,
    });
  }

  async receiveStatus(
    body: TwilioStatusWebhook,
    request: TwilioWebhookRequest,
    internalCallId?: string,
  ): Promise<void> {
    this.validateSignature(request);
    const status = statusMap[body.CallStatus];
    if (!status) {
      throw new ApiError(
        422,
        "UNSUPPORTED_TWILIO_STATUS",
        "Twilio envió un estado de llamada no soportado.",
        { callStatus: body.CallStatus },
      );
    }

    if (internalCallId) {
      const existing = await this.dependencies.callsService.findByProviderCallId(
        body.CallSid,
      );
      if (existing && existing.id !== internalCallId) {
        throw new ApiError(
          409,
          "CALL_PROVIDER_ID_CONFLICT",
          "El CallSid está asociado con otra llamada interna.",
          { internalCallId, actualCallId: existing.id },
        );
      }
      if (!existing) {
        await this.dependencies.callsService.ensureProviderCallId(
          internalCallId,
          body.CallSid,
        );
      }
    }
    await this.dependencies.callsService.applyProviderStatus(body.CallSid, status);
  }

  private async createInboundCall(body: TwilioVoiceWebhook) {
    const context = await this.dependencies.voiceCore.resolveInboundCallContext({
      fromNumber: body.From,
      toNumber: body.To,
    });
    return this.dependencies.callsService.createOrGetInbound({
      ...context,
      providerCallId: body.CallSid,
      fromNumber: body.From,
      toNumber: body.To,
      status: statusMap[body.CallStatus ?? ""] ?? "QUEUED",
    });
  }

  private validateSignature(request: TwilioWebhookRequest): void {
    if (this.dependencies.requireValidSignature === false) return;
    if (!this.dependencies.signatureValidator.validate(request)) {
      throw new ApiError(
        403,
        "INVALID_TWILIO_SIGNATURE",
        "La firma del webhook de Twilio no es válida.",
      );
    }
  }
}
