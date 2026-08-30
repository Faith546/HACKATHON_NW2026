import twilio from "twilio";
import { ApiError } from "../../shared/http/api-error";

export interface JoinHumanConferenceInput {
  escalationId: string;
  operationId: string;
  callId: string;
  providerCallId: string;
  humanPhone: string;
}

export interface JoinHumanConferenceResult {
  conferenceSid: string;
  humanParticipantCallSid: string | null;
}

export interface HumanConferenceGateway {
  joinHuman(
    input: JoinHumanConferenceInput,
  ): Promise<JoinHumanConferenceResult>;
}

export interface TwilioConferenceApi {
  redirectCall(callSid: string, twiml: string): Promise<void>;
  findActiveConference(
    friendlyName: string,
  ): Promise<{ sid: string } | null>;
  addParticipant(
    conferenceReference: string,
    input: {
      from: string;
      to: string;
      label: string;
    },
  ): Promise<{ callSid: string | null; conferenceSid: string | null }>;
  findParticipantByLabel?(
    conferenceSid: string,
    label: string,
  ): Promise<{ callSid: string | null } | null>;
  getCallStatus(callSid: string): Promise<string>;
}

export interface TwilioHumanConferenceGatewayConfig {
  fromNumber: string;
  discoveryAttempts?: number;
  discoveryIntervalMs?: number;
  participantAnswerAttempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

/**
 * The human is dialed first. The live carrier call is redirected only after
 * Twilio confirms the human answered, so a busy/no-answer operator cannot
 * strand the carrier in an empty conference.
 */
export class TwilioHumanConferenceGateway
  implements HumanConferenceGateway
{
  private readonly discoveryAttempts: number;
  private readonly discoveryIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly participantAnswerAttempts: number;
  private readonly completedJoins = new Map<
    string,
    JoinHumanConferenceResult
  >();

  constructor(
    private readonly config: TwilioHumanConferenceGatewayConfig,
    private readonly api: TwilioConferenceApi,
  ) {
    this.discoveryAttempts = config.discoveryAttempts ?? 8;
    this.discoveryIntervalMs = config.discoveryIntervalMs ?? 250;
    this.participantAnswerAttempts =
      config.participantAnswerAttempts ?? 120;
    this.wait =
      config.wait ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      !Number.isInteger(this.discoveryAttempts) ||
      this.discoveryAttempts < 1
    ) {
      throw new Error("discoveryAttempts must be a positive integer");
    }
    if (this.discoveryIntervalMs < 0) {
      throw new Error("discoveryIntervalMs must be non-negative");
    }
    if (
      !Number.isInteger(this.participantAnswerAttempts) ||
      this.participantAnswerAttempts < 1
    ) {
      throw new Error("participantAnswerAttempts must be a positive integer");
    }
  }

  async joinHuman(
    input: JoinHumanConferenceInput,
  ): Promise<JoinHumanConferenceResult> {
    const completed = this.completedJoins.get(input.escalationId);
    if (completed) return completed;

    const from = required(this.config.fromNumber, "TWILIO_PHONE_NUMBER");
    const conferenceName = conferenceNameFor(input.escalationId);
    const participantLabel = `human-${input.escalationId}`.slice(0, 128);

    const conference = await this.api.findActiveConference(conferenceName);
    const existingParticipant = conference
      ? await this.api.findParticipantByLabel?.(
          conference.sid,
          participantLabel,
        )
      : null;
    const participant =
      existingParticipant ??
      (await this.api.addParticipant(conference?.sid ?? conferenceName, {
        from,
        to: input.humanPhone,
        label: participantLabel,
      }));
    const participantCallSid = participant.callSid;
    if (!participantCallSid) {
      throw new ApiError(
        503,
        "TWILIO_PARTICIPANT_CALL_MISSING",
        "Twilio no devolvió el CallSid del participante humano.",
      );
    }
    await this.waitForHumanAnswer(participantCallSid);

    const participantConferenceSid =
      "conferenceSid" in participant &&
      typeof participant.conferenceSid === "string"
        ? participant.conferenceSid
        : null;
    const conferenceSid =
      conference?.sid ??
      participantConferenceSid ??
      (await this.discoverConference(conferenceName)).sid;

    await this.api.redirectCall(
      required(input.providerCallId, "twilioCallSid"),
      createConferenceTwiml(conferenceName),
    );

    const result = {
      conferenceSid,
      humanParticipantCallSid: participantCallSid,
    };
    this.completedJoins.set(input.escalationId, result);
    return result;
  }

  private async waitForHumanAnswer(callSid: string): Promise<void> {
    const terminalFailures = new Set([
      "busy",
      "failed",
      "no-answer",
      "canceled",
      "completed",
    ]);
    for (
      let attempt = 1;
      attempt <= this.participantAnswerAttempts;
      attempt += 1
    ) {
      const status = (await this.api.getCallStatus(callSid)).toLowerCase();
      if (status === "in-progress" || status === "answered") return;
      if (terminalFailures.has(status)) {
        throw new ApiError(
          503,
          "HUMAN_DID_NOT_JOIN",
          "El participante humano no contestó la llamada de conferencia.",
          { callSid, status },
        );
      }
      if (attempt < this.participantAnswerAttempts) {
        await this.wait(this.discoveryIntervalMs);
      }
    }
    throw new ApiError(
      503,
      "HUMAN_ANSWER_TIMEOUT",
      "No se confirmó que el participante humano contestara a tiempo.",
      { callSid },
    );
  }

  private async discoverConference(
    friendlyName: string,
  ): Promise<{ sid: string }> {
    for (let attempt = 1; attempt <= this.discoveryAttempts; attempt += 1) {
      const conference = await this.api.findActiveConference(friendlyName);
      if (conference) return conference;
      if (attempt < this.discoveryAttempts) {
        await this.wait(this.discoveryIntervalMs);
      }
    }
    throw new ApiError(
      503,
      "TWILIO_CONFERENCE_NOT_READY",
      "Twilio no expuso la conferencia activa dentro del tiempo esperado.",
      { friendlyName },
    );
  }
}

export class TwilioSdkConferenceApi implements TwilioConferenceApi {
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(
      required(accountSid, "TWILIO_ACCOUNT_SID"),
      required(authToken, "TWILIO_AUTH_TOKEN"),
    );
  }

  async redirectCall(callSid: string, twiml: string): Promise<void> {
    await this.client.calls(callSid).update({ twiml });
  }

  async findActiveConference(
    friendlyName: string,
  ): Promise<{ sid: string } | null> {
    const conferences = await this.client.conferences.list({
      friendlyName,
      status: "in-progress",
      limit: 1,
    });
    return conferences[0] ? { sid: conferences[0].sid } : null;
  }

  async addParticipant(
    conferenceReference: string,
    input: { from: string; to: string; label: string },
  ): Promise<{ callSid: string | null; conferenceSid: string | null }> {
    const participant = await this.client
      .conferences(conferenceReference)
      .participants.create({
        from: input.from,
        to: input.to,
        label: input.label,
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        beep: "false",
        conferenceRecord: "do-not-record",
      });
    return {
      callSid: participant.callSid ?? null,
      conferenceSid: participant.conferenceSid ?? null,
    };
  }

  async findParticipantByLabel(
    conferenceSid: string,
    label: string,
  ): Promise<{ callSid: string | null } | null> {
    const participants = await this.client
      .conferences(conferenceSid)
      .participants.list({ limit: 100 });
    const matching = participants.find(
      (participant) => participant.label === label,
    );
    return matching ? { callSid: matching.callSid ?? null } : null;
  }

  async getCallStatus(callSid: string): Promise<string> {
    const call = await this.client.calls(callSid).fetch();
    return call.status;
  }
}

export class UnavailableHumanConferenceGateway
  implements HumanConferenceGateway
{
  async joinHuman(): Promise<never> {
    throw new ApiError(
      503,
      "TELEPHONY_NOT_CONFIGURED",
      "La conferencia humana requiere credenciales y número de Twilio.",
    );
  }
}

export function createConferenceTwiml(conferenceName: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Dial>",
    '<Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" record="do-not-record">',
    escapeXml(conferenceName),
    "</Conference>",
    "</Dial>",
    "</Response>",
  ].join("");
}

export function conferenceNameFor(escalationId: string): string {
  const safeId = escalationId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `nextwave-${safeId}`.slice(0, 128);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function required(value: string, name: string): string {
  if (!value || value.trim() === "") {
    throw new ApiError(
      503,
      "TELEPHONY_NOT_CONFIGURED",
      `Falta la configuración ${name}.`,
    );
  }
  return value.trim();
}
