import type {
  RecordingReference,
  RecordingStatus,
} from "../domain/recording.js";

export interface RecordingStore {
  upsert(recording: RecordingReference): RecordingReference;
  getByCallId(callId: string): RecordingReference | undefined;
  getByRecordingSid(recordingSid: string): RecordingReference | undefined;
}

const statusRank: Record<RecordingStatus, number> = {
  unknown: 0,
  "in-progress": 1,
  paused: 1,
  stopped: 2,
  processing: 2,
  completed: 3,
  absent: 3,
};

function clone(recording: RecordingReference): RecordingReference {
  return structuredClone(recording);
}

export class InMemoryRecordingStore implements RecordingStore {
  private readonly byRecordingSid = new Map<string, RecordingReference>();
  private readonly latestRecordingSidByCallId = new Map<string, string>();

  upsert(recording: RecordingReference): RecordingReference {
    const existing = this.byRecordingSid.get(recording.recordingSid);

    if (existing && existing.callId !== recording.callId) {
      throw new Error(
        `RecordingSid ${recording.recordingSid} is already linked to another CallSid`,
      );
    }

    const status =
      existing && statusRank[existing.status] > statusRank[recording.status]
        ? existing.status
        : recording.status;
    const next: RecordingReference = {
      ...existing,
      callId: recording.callId,
      recordingSid: recording.recordingSid,
      status,
    };
    const optionalFields = [
      "startRequestedAt",
      "startedAt",
      "durationMs",
      "channels",
      "track",
      "source",
    ] as const;
    for (const field of optionalFields) {
      const value = recording[field];
      if (value !== undefined) {
        Object.assign(next, { [field]: value });
      }
    }

    this.byRecordingSid.set(next.recordingSid, clone(next));
    this.latestRecordingSidByCallId.set(next.callId, next.recordingSid);
    return clone(next);
  }

  getByCallId(callId: string): RecordingReference | undefined {
    const recordingSid = this.latestRecordingSidByCallId.get(callId);
    if (!recordingSid) return undefined;
    return this.getByRecordingSid(recordingSid);
  }

  getByRecordingSid(recordingSid: string): RecordingReference | undefined {
    const recording = this.byRecordingSid.get(recordingSid);
    return recording ? clone(recording) : undefined;
  }
}

export const recordingStore = new InMemoryRecordingStore();
