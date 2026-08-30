import type { Request, Response } from "express";
import { ApiError } from "../../shared/http/api-error";
import type { WebhooksService } from "./webhooks.service";
import type {
  TwilioStatusWebhook,
  TwilioRecordingStatusWebhook,
  TwilioVoiceWebhook,
  TwilioWebhookRequest,
} from "./webhooks.types";

function formParameters(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(422, "VALIDATION_ERROR", "El formulario Twilio es inválido.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function required(parameters: Record<string, string>, field: string): string {
  const value = parameters[field];
  if (!value) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} es obligatorio.`, {
      field,
    });
  }
  return value;
}

export class WebhooksController {
  constructor(
    private readonly service: WebhooksService,
    private readonly publicBaseUrl: string,
  ) {}

  receiveVoice = async (request: Request, response: Response) => {
    const parameters = formParameters(request.body);
    const twilioRequest = this.twilioRequest(request, parameters);
    const body: TwilioVoiceWebhook = {
      CallSid: required(parameters, "CallSid"),
      From: required(parameters, "From"),
      To: required(parameters, "To"),
      CallStatus: parameters.CallStatus,
    };
    console.info(
      `[TWILIO_VOICE_WEBHOOK] received CallSid=${masked(body.CallSid)} From=${masked(body.From)}`,
    );
    const twiml = await this.service.receiveVoice(body, twilioRequest);
    console.info(
      `[TWILIO_VOICE_WEBHOOK] accepted CallSid=${masked(body.CallSid)}`,
    );
    response.status(200).type("text/xml").send(twiml);
  };

  receiveStatus = async (request: Request, response: Response) => {
    const parameters = formParameters(request.body);
    const twilioRequest = this.twilioRequest(request, parameters);
    const body: TwilioStatusWebhook = {
      CallSid: required(parameters, "CallSid"),
      CallStatus: required(parameters, "CallStatus"),
      From: parameters.From,
      To: parameters.To,
    };
    const callId = typeof request.query.callId === "string"
      ? request.query.callId
      : undefined;
    await this.service.receiveStatus(body, twilioRequest, callId);
    response.status(204).send();
  };

  receiveRecordingStatus = async (request: Request, response: Response) => {
    const parameters = formParameters(request.body);
    const twilioRequest = this.twilioRequest(request, parameters);
    const body: TwilioRecordingStatusWebhook = {
      CallSid: required(parameters, "CallSid"),
      RecordingSid: required(parameters, "RecordingSid"),
      RecordingStatus: required(parameters, "RecordingStatus"),
      RecordingUrl: parameters.RecordingUrl,
      RecordingDuration: parameters.RecordingDuration,
    };
    const callId = typeof request.query.callId === "string" ? request.query.callId : undefined;
    await this.service.receiveRecordingStatus(body, twilioRequest, callId);
    response.status(204).send();
  };

  private twilioRequest(
    request: Request,
    parameters: Record<string, string>,
  ): TwilioWebhookRequest {
    const requestUrl = new URL(request.originalUrl, this.publicBaseUrl).toString();
    return {
      signature: request.header("x-twilio-signature"),
      requestUrl,
      parameters,
    };
  }
}

function masked(value: string): string {
  const suffix = value.slice(-4);
  return suffix ? `***${suffix}` : "***";
}
