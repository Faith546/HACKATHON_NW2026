export type CallContext = {
  callId: string;
  operationId: string;
  mandateVersion: number;
  startedAt: string;
  streamSid?: string;
  carrierId?: string;
};
