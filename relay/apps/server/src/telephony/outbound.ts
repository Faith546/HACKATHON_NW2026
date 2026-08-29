export type StartCarrierCallInput = {
  operationId: string;
  carrierId: string;
};

export type StartCarrierCallResult = {
  callId: string;
};

export interface OutboundCarrierCallService {
  startCarrierCall(input: StartCarrierCallInput): Promise<StartCarrierCallResult>;
}

// TODO(outbound): resolve carrierId through a registered-carrier allowlist before
// dialing. Checkpoint 3 intentionally has no implementation and no HTTP endpoint.
