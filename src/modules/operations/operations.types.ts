import { z } from "zod";

export const CreateOperationSchema = z.object({
  operatorId: z.string().min(1),
  customerName: z.string().min(1),
  containerNumber: z.string().min(1),
  origin: z.string().min(1),
  destination: z.string().min(1),
  service: z.enum(["DRAYAGE"]).default("DRAYAGE"),
  notes: z.string().optional(),
  mandate: z.object({
    maxTotalPrice: z.number().positive(),
    currency: z.string().default("MXN"),
    pickupDate: z.string().datetime({ offset: true }), // ISO 8601 string
    notes: z.string().optional(),
  }),
});

export type CreateOperationInput = z.infer<typeof CreateOperationSchema>;
