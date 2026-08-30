import { z } from "zod";

const requiredText = z.string().trim().min(1);

export const ConfirmExecutionEventSchema = z.object({
  callId: requiredText,
  occurredAt: z.string().datetime({ offset: true }),
  confirmedBy: requiredText,
  notes: requiredText.optional(),
});

export type ConfirmExecutionEventInput = z.infer<
  typeof ConfirmExecutionEventSchema
>;

export interface OperationMandateResponse {
  id: string;
  operationId: string;
  version: number;
  status: string;
  maxTotalPrice: number;
  currency: string;
  pickupDate: string;
  notes?: string;
  createdAt: string;
}

export interface OperationExecutionResponse {
  id: string;
  customerName: string;
  containerNumber: string;
  origin: string;
  destination: string;
  service: string;
  status: string;
  selectedCarrierId: string | null;
  notes?: string;
  mandate: OperationMandateResponse;
  createdAt: string;
  updatedAt: string;
}
