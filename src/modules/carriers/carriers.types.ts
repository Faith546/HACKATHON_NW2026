import { z } from "zod";

export const CreateCarrierSchema = z.object({
  name: z.string().min(1),
  dispatcherName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
});

export type CreateCarrierInput = z.infer<typeof CreateCarrierSchema>;
