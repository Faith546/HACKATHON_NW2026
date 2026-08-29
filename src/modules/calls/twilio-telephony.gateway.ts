import twilio from "twilio";
import { ApiError } from "../../shared/http/api-error";
import type {
  StartOutboundCallInput,
  TelephonyGateway,
} from "./calls.types";
import { createMediaStreamTwiml } from "./twilio-twiml";

type TwilioClient = ReturnType<typeof twilio>;
type TwilioCreateCallInput = Parameters<TwilioClient["calls"]["create"]>[0];

export interface TwilioCallsClient {
  calls: {
    create(input: TwilioCreateCallInput): Promise<{ sid: string }>;
  };
}

export interface TwilioTelephonyConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  publicBaseUrl: string;
  publicWssUrl: string;
}

function required(value: string, name: string): string {
  if (value.trim() === "") {
    throw new ApiError(
      503,
      "TELEPHONY_NOT_CONFIGURED",
      `Falta la configuración ${name}.`,
    );
  }
  return value.trim();
}

function secureUrl(value: string, protocol: "https:" | "wss:", name: string) {
  const url = new URL(required(value, name));
  if (url.protocol !== protocol) {
    throw new ApiError(
      503,
      "TELEPHONY_NOT_CONFIGURED",
      `${name} debe usar ${protocol.replace(":", "")}.`,
    );
  }
  return url;
}

export class TwilioTelephonyGateway implements TelephonyGateway {
  private readonly client: TwilioCallsClient;

  constructor(
    private readonly config: TwilioTelephonyConfig,
    client?: TwilioCallsClient,
  ) {
    this.client =
      client ??
      twilio(
        required(config.accountSid, "TWILIO_ACCOUNT_SID"),
        required(config.authToken, "TWILIO_AUTH_TOKEN"),
      );
  }

  async startOutboundCall(
    input: StartOutboundCallInput,
  ): Promise<{ providerCallId: string }> {
    if (!input.toNumber) {
      throw new ApiError(
        422,
        "CARRIER_PHONE_MISSING",
        "No se puede iniciar la llamada sin teléfono destino.",
        { carrierId: input.carrierId },
      );
    }
    const baseUrl = secureUrl(
      this.config.publicBaseUrl,
      "https:",
      "PUBLIC_BASE_URL",
    );
    const streamUrl = secureUrl(
      this.config.publicWssUrl,
      "wss:",
      "PUBLIC_WSS_URL",
    );
    streamUrl.pathname = "/ws/twilio-media";
    streamUrl.search = "";
    streamUrl.hash = "";

    const statusCallback = new URL(
      "/api/v1/webhooks/twilio/status",
      baseUrl,
    );
    statusCallback.searchParams.set("callId", input.callId);
    const providerCall = await this.client.calls.create({
      to: input.toNumber,
      from: required(this.config.fromNumber, "TWILIO_PHONE_NUMBER"),
      twiml: createMediaStreamTwiml({
        streamUrl: streamUrl.toString(),
        callId: input.callId,
      }),
      statusCallback: statusCallback.toString(),
      statusCallbackMethod: "POST",
      statusCallbackEvent: [
        "initiated",
        "ringing",
        "answered",
        "completed",
      ],
    });
    return { providerCallId: providerCall.sid };
  }
}
