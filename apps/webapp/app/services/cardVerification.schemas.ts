import { z } from "zod";

export const CardVerificationResultSchema = z.object({
  supported: z.boolean(),
  verified: z.boolean(),
  verifiedAt: z.string().datetime().optional(),
});

export type CardVerification = z.infer<typeof CardVerificationResultSchema>;

export const FreeCardCheckoutResultSchema = z.object({
  checkoutUrl: z.string().url(),
});
