import twilio from "twilio";
import { ApiError } from "../../shared/http/api-error";

export interface SummarySender {
  send(input: {
    channel: "SMS" | "EMAIL";
    recipient: string;
    message: string;
  }): Promise<{ providerId: string; acceptedAt: string }>;
}

type TwilioClient = ReturnType<typeof twilio>;
type TwilioMessageInput = Parameters<TwilioClient["messages"]["create"]>[0];

export interface TwilioMessagesClient {
  messages: {
    create(input: TwilioMessageInput): Promise<{ sid: string; dateCreated: Date }>;
  };
}

export class TwilioSmsSummarySender implements SummarySender {
  private readonly client: TwilioMessagesClient;

  constructor(
    private readonly config: {
      accountSid: string;
      authToken: string;
      fromNumber: string;
    },
    client?: TwilioMessagesClient,
  ) {
    this.client =
      client ?? twilio(config.accountSid, config.authToken);
  }

  supports(channel: "SMS" | "EMAIL"): boolean {
    return channel === "SMS";
  }

  async send(input: {
    channel: "SMS" | "EMAIL";
    recipient: string;
    message: string;
  }): Promise<{ providerId: string; acceptedAt: string }> {
    if (input.channel !== "SMS") {
      throw new ApiError(
        422,
        "SUMMARY_CHANNEL_UNSUPPORTED",
        "Este adapter sólo soporta resúmenes por SMS.",
      );
    }
    if (!input.recipient.trim() || !input.message.trim()) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "El destinatario y mensaje del resumen son obligatorios.",
      );
    }
    const result = await this.client.messages.create({
      to: input.recipient,
      from: this.config.fromNumber,
      body: input.message,
    });
    return {
      providerId: result.sid,
      acceptedAt: result.dateCreated.toISOString(),
    };
  }
}
