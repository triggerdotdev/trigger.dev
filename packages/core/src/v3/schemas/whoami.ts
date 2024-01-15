import { z } from "zod";

export const WhoAmIResponseSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
});

export type WhoAmIResponse = z.infer<typeof WhoAmIResponseSchema>;
