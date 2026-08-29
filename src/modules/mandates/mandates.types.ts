import { z } from "zod";

export const CreateMandateVersionSchema = z.object({
  maxTotalPrice: z.number().positive(),
  currency: z.string().default("MXN"),
  pickupDate: z.string().datetime({ offset: true }),
  notes: z.string().optional(),
  operatorId: z.string().min(1), // Who authorized this new version
});

export type CreateMandateVersionInput = z.infer<typeof CreateMandateVersionSchema>;
