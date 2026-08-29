import { randomUUID } from "node:crypto";
import { AuditWriter } from "../../shared/audit/audit-writer";
import { DrizzleAuditEventRepository } from "../../shared/audit/drizzle-audit.repository";
import { ApiError } from "../../shared/http/api-error";
import { InMemoryJobQueue } from "../../shared/queue/in-memory-job-queue";
import {
  DrizzleCallRepository,
  InMemoryCallRepository,
  type CallRepository,
} from "../calls/calls.repository";
import { CallsService } from "../calls/calls.service";
import type {
  OutboundCallContextResolver,
  TelephonyGateway,
} from "../calls/calls.types";
import { TwilioTelephonyGateway } from "../calls/twilio-telephony.gateway";
import { InMemoryRealtimeSessionRepository } from "../realtime/realtime.repository";
import { RealtimeService } from "../realtime/realtime.service";
import {
  TwilioRequestSignatureValidator,
} from "../webhooks/webhooks.repository";
import { WebhooksService } from "../webhooks/webhooks.service";
import type { TwilioSignatureValidator } from "../webhooks/webhooks.types";
import type {
  InboundCallResolution,
  VoiceCorePort,
  VoiceMandateSnapshot,
  VoiceToolContext,
  VoiceToolName,
} from "./voice-core.port";
import { DrizzleVoiceCoreAdapter } from "./drizzle-voice-core.adapter";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as databaseSchema from "../../db/schema";

class FakeTelephonyGateway implements TelephonyGateway {
  async startOutboundCall(): Promise<{ providerCallId: string }> {
    return { providerCallId: `CA_FAKE_${randomUUID()}` };
  }
}

class LocalFallbackVoiceCore implements VoiceCorePort {
  async resolveOutboundCallContext(): Promise<{ toNumber: string }> {
    return { toNumber: "+10000000000" };
  }

  async resolveInboundCallContext(): Promise<InboundCallResolution> {
    throw this.unavailable();
  }

  async getActiveMandate(): Promise<VoiceMandateSnapshot | null> {
    return null;
  }

  async executeVoiceTool(_input: {
    name: VoiceToolName;
    context: VoiceToolContext;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    throw this.unavailable();
  }

  private unavailable(): ApiError {
    return new ApiError(
      503,
      "VOICE_CORE_UNAVAILABLE",
      "Parte A todavía no conectó VoiceCorePort.",
    );
  }
}

class RejectingSignatureValidator implements TwilioSignatureValidator {
  validate(): boolean {
    return false;
  }
}

export interface VoiceRuntime {
  callsService: CallsService;
  realtimeService: RealtimeService;
  webhooksService: WebhooksService;
  publicBaseUrl: string;
  publicWssUrl: string;
}

export interface CreateVoiceRuntimeOptions {
  callsService?: CallsService;
  realtimeService?: RealtimeService;
  webhooksService?: WebhooksService;
  repository?: CallRepository;
  queue?: InMemoryJobQueue;
  telephonyGateway?: TelephonyGateway;
  voiceCore?: VoiceCorePort;
  auditWriter?: AuditWriter;
  signatureValidator?: TwilioSignatureValidator;
  publicBaseUrl?: string;
  publicWssUrl?: string;
  requireValidTwilioSignature?: boolean;
}

export function createVoiceRuntime(
  options: CreateVoiceRuntimeOptions = {},
): VoiceRuntime {
  const publicBaseUrl =
    options.publicBaseUrl ??
    process.env.PUBLIC_BASE_URL ??
    "http://127.0.0.1:3000";
  const publicWssUrl =
    options.publicWssUrl ??
    process.env.PUBLIC_WSS_URL ??
    "ws://127.0.0.1:3000";
  const voiceCore = options.voiceCore ?? new LocalFallbackVoiceCore();
  const auditWriter =
    options.auditWriter ?? new AuditWriter({ insert: () => undefined });
  const contextResolver: OutboundCallContextResolver = {
    resolve: (input) => voiceCore.resolveOutboundCallContext(input),
  };
  const telephonyGateway =
    options.telephonyGateway ??
    (options.voiceCore
      ? configuredTwilioGateway(publicBaseUrl, publicWssUrl)
      : null) ??
    new FakeTelephonyGateway();
  const callsService =
    options.callsService ??
    new CallsService({
      repository: options.repository ?? new InMemoryCallRepository(),
      queue:
        options.queue ??
        new InMemoryJobQueue({ concurrency: 3, maxRetries: 2 }),
      telephonyGateway,
      contextResolver,
      auditWriter,
    });
  const realtimeService =
    options.realtimeService ??
    new RealtimeService({
      repository: new InMemoryRealtimeSessionRepository(),
      callsService,
      voiceCore,
      auditWriter,
    });
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const signatureValidator =
    options.signatureValidator ??
    (authToken
      ? new TwilioRequestSignatureValidator(authToken)
      : new RejectingSignatureValidator());
  const webhooksService =
    options.webhooksService ??
    new WebhooksService({
      callsService,
      voiceCore,
      signatureValidator,
      publicWssUrl,
      requireValidSignature:
        options.requireValidTwilioSignature ?? true,
    });

  return {
    callsService,
    realtimeService,
    webhooksService,
    publicBaseUrl,
    publicWssUrl,
  };
}

type VoiceDatabase = BetterSQLite3Database<typeof databaseSchema>;

export function createDrizzleVoiceRuntime(
  database: VoiceDatabase,
  options: Omit<
    CreateVoiceRuntimeOptions,
    "repository" | "auditWriter"
  > = {},
): VoiceRuntime {
  const voiceCore = options.voiceCore ?? new DrizzleVoiceCoreAdapter(database);
  return createVoiceRuntime({
    ...options,
    voiceCore,
    repository: new DrizzleCallRepository(database),
    auditWriter: new AuditWriter(new DrizzleAuditEventRepository(database)),
  });
}

function configuredTwilioGateway(
  publicBaseUrl: string,
  publicWssUrl: string,
): TwilioTelephonyGateway | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const fromNumber = process.env.TWILIO_PHONE_NUMBER ?? "";
  if (!accountSid || !authToken || !fromNumber) return null;
  return new TwilioTelephonyGateway({
    accountSid,
    authToken,
    fromNumber,
    publicBaseUrl,
    publicWssUrl,
  });
}
