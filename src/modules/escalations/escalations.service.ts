import { db } from "../../db";
import { InMemoryJobQueue } from "../../shared/queue/in-memory-job-queue";
import {
  EscalationsRepository,
  type EscalationRecord,
  type EscalationsDatabase,
  type EscalationsRepositoryOptions,
} from "./escalations.repository";
import type {
  JoinHumanInput,
  RequestEscalationInput,
  ResolveEscalationInput,
} from "./escalations.types";
import {
  TwilioHumanConferenceGateway,
  TwilioSdkConferenceApi,
  UnavailableHumanConferenceGateway,
  type HumanConferenceGateway,
  type JoinHumanConferenceResult,
} from "./human-conference.gateway";

export interface EscalationJobQueue {
  enqueue(job: {
    id: string;
    run(): Promise<void>;
    onExhausted?(error: unknown): Promise<void> | void;
  }): void;
}

export class EscalationsService {
  private readonly activeJoinJobs = new Set<string>();

  constructor(
    private readonly repository: EscalationsRepository,
    private readonly queue: EscalationJobQueue,
    private readonly conferenceGateway: HumanConferenceGateway,
  ) {}

  requestEscalation(
    operationId: string,
    input: RequestEscalationInput,
    actorId?: string,
  ): EscalationRecord {
    return this.repository.requestEscalation(operationId, input, actorId);
  }

  joinHuman(
    escalationId: string,
    input: JoinHumanInput,
    actorId?: string,
  ): EscalationRecord {
    const context = this.repository.beginHumanJoin(
      escalationId,
      input,
      actorId,
    );
    if (context.alreadyQueued && this.activeJoinJobs.has(escalationId)) {
      return context.escalation;
    }
    this.activeJoinJobs.add(escalationId);
    console.info(`[HUMAN_HANDOFF] queued escalationId=${escalationId}`);
    let gatewayResult: JoinHumanConferenceResult | null = null;

    this.queue.enqueue({
      id: `join-human:${escalationId}`,
      run: async () => {
        this.repository.assertJoinStillActive(escalationId);
        gatewayResult ??=
          await this.conferenceGateway.joinHuman(context.gatewayInput);
        this.repository.markHumanJoined(escalationId, gatewayResult);
        console.info(`[HUMAN_HANDOFF] joined escalationId=${escalationId}`);
        this.activeJoinJobs.delete(escalationId);
      },
      onExhausted: (error) => {
        this.repository.markHumanJoinFailed(escalationId, error);
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "UNKNOWN";
        console.error(
          `[HUMAN_HANDOFF] failed escalationId=${escalationId} code=${code}`,
        );
        this.activeJoinJobs.delete(escalationId);
      },
    });

    return context.escalation;
  }

  getEscalation(escalationId: string): EscalationRecord | null {
    return this.repository.findById(escalationId);
  }

  resolveEscalation(
    escalationId: string,
    input: ResolveEscalationInput,
    actorId?: string,
  ): EscalationRecord {
    return this.repository.resolve(escalationId, input, actorId);
  }
}

export interface CreateEscalationsServiceOptions
  extends EscalationsRepositoryOptions {
  database?: EscalationsDatabase;
  queue?: EscalationJobQueue;
  conferenceGateway?: HumanConferenceGateway;
}

export function createEscalationsService(
  options: CreateEscalationsServiceOptions = {},
): EscalationsService {
  const {
    database = db,
    queue = new InMemoryJobQueue({ concurrency: 1, maxRetries: 2 }),
    conferenceGateway = configuredConferenceGateway(),
    ...repositoryOptions
  } = options;
  return new EscalationsService(
    new EscalationsRepository(database, repositoryOptions),
    queue,
    conferenceGateway,
  );
}

export function configuredConferenceGateway(
  environment: NodeJS.ProcessEnv = process.env,
): HumanConferenceGateway {
  const accountSid = environment.TWILIO_ACCOUNT_SID ?? "";
  const authToken = environment.TWILIO_AUTH_TOKEN ?? "";
  const fromNumber = environment.TWILIO_PHONE_NUMBER ?? "";
  if (!accountSid || !authToken || !fromNumber) {
    return new UnavailableHumanConferenceGateway();
  }
  return new TwilioHumanConferenceGateway(
    { fromNumber },
    new TwilioSdkConferenceApi(accountSid, authToken),
  );
}

export const escalationsService = createEscalationsService();
