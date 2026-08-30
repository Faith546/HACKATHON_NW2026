export interface TwilioVoiceWebhook {
  CallSid: string;
  From: string;
  To: string;
  CallStatus?: string;
}

export interface TwilioStatusWebhook {
  CallSid: string;
  CallStatus: string;
  From?: string;
  To?: string;
}

export interface TwilioWebhookRequest {
  signature: string | undefined;
  requestUrl: string;
  parameters: Record<string, string>;
}

export interface TwilioSignatureValidator {
  validate(input: TwilioWebhookRequest): boolean;
}
