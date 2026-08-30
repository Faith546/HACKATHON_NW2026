export type TwilioStreamTiming = {
  clock: "twilio_stream";
  streamSid: string;
  firstMediaTimestampMs?: number;
  lastMediaTimestampMs?: number;
  firstSequenceNumber?: number;
  lastSequenceNumber?: number;
  firstChunk?: number;
  lastChunk?: number;
  lastTrack?: string;
};

export type CallerSpeechRange = {
  clock: "openai_input";
  itemId: string;
  startMs?: number;
  endMs?: number;
};

export type CallTiming = {
  callId: string;
  stream: TwilioStreamTiming;
  callerSpeechRanges: CallerSpeechRange[];
};

/**
 * A measured anchor supplied by a physical verification process. Relay does not
 * create these automatically because stream time and recording time are
 * independent clocks.
 */
export type VerifiedRecordingClockAnchor = {
  streamSid: string;
  recordingSid: string;
  streamTimestampMs: number;
  recordingTimestampMs: number;
  verifiedBy: "physical_test";
};
