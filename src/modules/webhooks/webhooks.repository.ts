import twilio from "twilio";
import type {
  TwilioSignatureValidator,
  TwilioWebhookRequest,
} from "./webhooks.types";

export class TwilioRequestSignatureValidator
  implements TwilioSignatureValidator
{
  constructor(private readonly authToken: string) {}

  validate(input: TwilioWebhookRequest): boolean {
    if (!input.signature || this.authToken.trim() === "") return false;
    return twilio.validateRequest(
      this.authToken,
      input.signature,
      input.requestUrl,
      input.parameters,
    );
  }
}
