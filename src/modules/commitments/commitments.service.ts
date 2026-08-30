import { randomUUID } from "node:crypto";
import type { SummarySender } from "../calls/summary-sender";
import { ApiError } from "../../shared/http/api-error";
import {
  CommitmentsRepository,
  commitmentsRepository,
} from "./commitments.repository";
import type {
  AttachEvidenceInput,
  AuthorizeCommitmentInput,
  CommitmentRecord,
  SendSummaryInput,
  VerbalAgreementInput,
} from "./commitments.types";

export interface CommitmentSummaryJob {
  commitmentId: string;
}

export type CommitmentSummaryProcessor = (
  job: CommitmentSummaryJob,
) => Promise<void>;

export interface CommitmentSummaryQueue {
  enqueue(
    job: CommitmentSummaryJob,
    processor: CommitmentSummaryProcessor,
  ): void;
}

export interface CapableSummarySender extends SummarySender {
  supports?(channel: "SMS" | "EMAIL"): boolean;
}

interface QueuedSummaryJob {
  job: CommitmentSummaryJob;
  processor: CommitmentSummaryProcessor;
  attempt: number;
}

/**
 * In-process demo queue. A retry count of two means one initial attempt plus
 * two retries. Exhausted jobs remain SUMMARY_PENDING and can be retried later
 * without falsely validating the commitment.
 */
export class InMemoryCommitmentSummaryQueue
  implements CommitmentSummaryQueue
{
  private readonly pending: QueuedSummaryJob[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private active = 0;
  private scheduledRetries = 0;

  readonly exhausted: Array<{
    job: CommitmentSummaryJob;
    error: unknown;
  }> = [];

  constructor(
    private readonly concurrency = 1,
    private readonly maxRetries = 2,
    private readonly retryDelayMs = 10,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Summary queue concurrency must be at least one.");
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Error("Summary queue maxRetries cannot be negative.");
    }
  }

  enqueue(
    job: CommitmentSummaryJob,
    processor: CommitmentSummaryProcessor,
  ): void {
    this.pending.push({ job, processor, attempt: 0 });
    queueMicrotask(() => this.pump());
  }

  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;
      this.active += 1;
      void this.run(item);
    }
    this.resolveIdleWaitersIfNeeded();
  }

  private async run(item: QueuedSummaryJob): Promise<void> {
    try {
      await item.processor(item.job);
    } catch (error) {
      if (item.attempt < this.maxRetries) {
        this.scheduledRetries += 1;
        setTimeout(() => {
          this.scheduledRetries -= 1;
          this.pending.push({ ...item, attempt: item.attempt + 1 });
          this.pump();
        }, this.retryDelayMs);
      } else {
        this.exhausted.push({ job: item.job, error });
      }
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private isIdle(): boolean {
    return (
      this.active === 0 &&
      this.pending.length === 0 &&
      this.scheduledRetries === 0
    );
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

/**
 * Safe local provider for the standalone demo. It performs no network call.
 * Production composition should inject TwilioSmsSummarySender or a composite
 * SMS/email adapter through createCommitmentsService.
 */
export class InMemoryAcceptedSummarySender implements CapableSummarySender {
  constructor(private readonly now: () => Date = () => new Date()) {}

  supports(_channel: "SMS" | "EMAIL"): boolean {
    return true;
  }

  async send(_input: {
    channel: "SMS" | "EMAIL";
    recipient: string;
    message: string;
  }): Promise<{ providerId: string; acceptedAt: string }> {
    return {
      providerId: `local_summary_${randomUUID()}`,
      acceptedAt: this.now().toISOString(),
    };
  }
}

export class CommitmentsService {
  constructor(
    private readonly repository: CommitmentsRepository,
    private readonly summarySender: CapableSummarySender,
    private readonly summaryQueue: CommitmentSummaryQueue,
  ) {}

  authorizeCommitment(
    operationId: string,
    input: AuthorizeCommitmentInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    return this.repository.authorize(operationId, input, actorId);
  }

  listCommitments(operationId: string): Promise<CommitmentRecord[]> {
    return this.repository.listByOperation(operationId);
  }

  getAuthorizedCommitment(
    operationId: string,
  ): Promise<CommitmentRecord | null> {
    return this.repository.findActiveByOperation(operationId);
  }

  recordVerbalAgreement(
    commitmentId: string,
    input: VerbalAgreementInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    return this.repository.recordVerbalAgreement(
      commitmentId,
      input,
      actorId,
    );
  }

  attachEvidence(
    commitmentId: string,
    input: AttachEvidenceInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    return this.repository.attachEvidence(commitmentId, input, actorId);
  }

  async enqueueSummary(
    commitmentId: string,
    input: SendSummaryInput,
    actorId?: string,
  ): Promise<CommitmentRecord> {
    if (
      this.summarySender.supports &&
      !this.summarySender.supports(input.channel)
    ) {
      throw new ApiError(
        422,
        "SUMMARY_CHANNEL_UNSUPPORTED",
        `El canal ${input.channel} no está configurado.`,
        { channel: input.channel },
      );
    }

    const pending = await this.repository.markSummaryPending(
      commitmentId,
      input,
      actorId,
    );
    this.summaryQueue.enqueue(
      { commitmentId },
      async (job) => {
        await this.sendSummary(job.commitmentId);
      },
    );
    return pending;
  }

  /** Process one already-enqueued recap without going through HTTP. */
  async sendSummary(commitmentId: string): Promise<CommitmentRecord> {
    const commitment = await this.repository.getCommitment(commitmentId);
    if (!commitment) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Commitment no encontrado.",
      );
    }

    if (commitment.status === "VALID") return commitment;
    if (commitment.status === "SUMMARY_SENT") {
      return this.repository.markValid(commitment.id);
    }
    if (commitment.status !== "SUMMARY_PENDING") {
      throw new ApiError(
        409,
        "INVALID_STATE",
        `No hay un recap pendiente para el commitment; estado actual: ${commitment.status}.`,
      );
    }
    if (
      !commitment.summaryChannel ||
      !commitment.summaryRecipient ||
      !commitment.summaryMessage
    ) {
      throw new ApiError(
        500,
        "SUMMARY_JOB_CORRUPTED",
        "El commitment no conserva todos los datos del recap.",
      );
    }

    const dispatchable = await this.repository.validateSummaryDispatch(
      commitment.id,
    );
    const acceptance = await this.summarySender.send({
      channel: dispatchable.summaryChannel as "SMS" | "EMAIL",
      recipient: dispatchable.summaryRecipient as string,
      message: dispatchable.summaryMessage as string,
    });
    await this.repository.markSummarySent(commitment.id, acceptance);
    return this.repository.markValid(commitment.id);
  }
}

export interface CreateCommitmentsServiceOptions {
  repository?: CommitmentsRepository;
  summarySender?: CapableSummarySender;
  summaryQueue?: CommitmentSummaryQueue;
}

export function createCommitmentsService(
  options: CreateCommitmentsServiceOptions = {},
): CommitmentsService {
  return new CommitmentsService(
    options.repository ?? commitmentsRepository,
    options.summarySender ?? new InMemoryAcceptedSummarySender(),
    options.summaryQueue ?? new InMemoryCommitmentSummaryQueue(),
  );
}

export const commitmentsService = createCommitmentsService();
