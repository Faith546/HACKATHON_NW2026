import { z } from "zod";

export const operationStatuses = [
  "CREATED",
  "SOURCING",
  "BOOKED",
  "PICKUP_PENDING",
  "PICKED_UP",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "NEEDS_RENEGOTIATION",
  "ESCALATED",
  "NEEDS_CARRIER",
  "CANCELLED",
] as const;

export type OperationStatus = (typeof operationStatuses)[number];

export const isoDateSchema = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  },
  { message: "Debe ser una fecha válida en formato YYYY-MM-DD." },
);

export const currencyInputSchema = z
  .string()
  .trim()
  .min(1);

export const currencySchema = currencyInputSchema
  .transform((value) => value.toUpperCase());

export const moneySchema = z
  .number()
  .finite()
  .positive()
  .max(Number.MAX_SAFE_INTEGER / 100)
  .refine((value) => Math.round(value * 100) > 0, {
    message: "El monto debe ser de al menos una unidad monetaria mínima.",
  });

export const CreateMandateInputSchema = z.object({
  maxTotalPrice: moneySchema,
  currency: currencySchema,
  pickupDate: isoDateSchema,
  notes: z.string().trim().min(1).optional(),
});

export const CreateOperationSchema = z.object({
  customerName: z.string().trim().min(1),
  containerNumber: z.string().trim().min(1),
  origin: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  weightKg: z.number().int().positive().optional().default(10000),
  service: z.literal("DRAYAGE"),
  mandate: CreateMandateInputSchema,
  notes: z.string().trim().min(1).optional(),
});

export const CreateOperationHttpSchema = CreateOperationSchema.extend({
  carrierId: z.string().trim().min(1).optional(),
});

export const ListOperationsQuerySchema = z.object({
  status: z.enum(operationStatuses).optional(),
});

export const CancelOperationSchema = z.object({
  reason: z.string().trim().min(1),
});

export type CreateOperationInput = z.infer<typeof CreateOperationSchema>;
export type CreateOperationHttpInput = z.infer<
  typeof CreateOperationHttpSchema
>;
export type ListOperationsQuery = z.infer<typeof ListOperationsQuerySchema>;
export type CancelOperationInput = z.infer<typeof CancelOperationSchema>;

export interface OperationResponse {
  id: string;
  customerName: string;
  containerNumber: string;
  origin: string;
  destination: string;
  service: "DRAYAGE";
  mandate: {
    id: string;
    operationId: string;
    version: number;
    status: "ACTIVE" | "SUPERSEDED";
    maxTotalPrice: number;
    currency: string;
    pickupDate: string;
    notes?: string;
    createdAt: string;
  };
  notes?: string;
  status: OperationStatus;
  selectedCarrierId: string | null;
  createdAt: string;
  updatedAt: string;
}
