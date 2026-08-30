import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TwilioTelephonyGateway,
  type TwilioCallsClient,
} from "../src/modules/calls/twilio-telephony.gateway";
import {
  TwilioSmsSummarySender,
  type TwilioMessagesClient,
} from "../src/modules/calls/summary-sender";

describe("TwilioTelephonyGateway", () => {
  it("creates an outbound call with status correlation and Media Stream", async () => {
    const requests: Record<string, unknown>[] = [];
    const mockClient = Object.assign(
      (callId?: string) => ({
        recordings: {
          create: async () => ({ sid: "RE_mock123" }),
        },
      }),
      {
        calls: Object.assign(
          (callId?: string) => ({
            recordings: {
              create: async () => ({ sid: "RE_mock123" }),
            },
          }),
          {
            create: async (input: any) => {
              requests.push(input as unknown as Record<string, unknown>);
              return { sid: "CA_PROVIDER" };
            },
          }
        )
      }
    ) as unknown as TwilioCallsClient;
    const gateway = new TwilioTelephonyGateway(
      {
        accountSid: "AC_TEST",
        authToken: "token",
        fromNumber: "+525500000002",
        publicBaseUrl: "https://example.test",
        publicWssUrl: "wss://example.test",
      },
      mockClient,
    );

    assert.deepEqual(
      await gateway.startOutboundCall({
        callId: "call_1",
        operationId: "op_1",
        carrierId: "car_1",
        negotiationId: "neg_1",
        purpose: "QUOTE",
        toNumber: "+525500000001",
      }),
      { providerCallId: "CA_PROVIDER" },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.to, "+525500000001");
    assert.match(String(requests[0]?.statusCallback), /callId=call_1/);
    assert.match(String(requests[0]?.twiml), /ws\/twilio-media\/call_1/);
    assert.match(String(requests[0]?.twiml), /<Parameter name="callId"/);
  });
});

describe("TwilioSmsSummarySender", () => {
  it("exposes the recap port consumed by commitments in Parte A", async () => {
    const requests: Record<string, unknown>[] = [];
    const client: TwilioMessagesClient = {
      messages: {
        create: async (input) => {
          requests.push(input as unknown as Record<string, unknown>);
          return {
            sid: "SM_PROVIDER",
            dateCreated: new Date("2026-08-29T12:00:00.000Z"),
          };
        },
      },
    };
    const sender = new TwilioSmsSummarySender(
      {
        accountSid: "AC_TEST",
        authToken: "token",
        fromNumber: "+525500000002",
      },
      client,
    );

    assert.deepEqual(
      await sender.send({
        channel: "SMS",
        recipient: "+525500000001",
        message: "Confirmación de servicio por $8,500 MXN.",
      }),
      {
        providerId: "SM_PROVIDER",
        acceptedAt: "2026-08-29T12:00:00.000Z",
      },
    );
    assert.equal(requests[0]?.from, "+525500000002");
    assert.equal(requests[0]?.to, "+525500000001");
  });
});
