import { z } from "zod";

export const MESSAGE_META = z.object({
  data: z.any(),
  id: z.string(),
  type: z.union([z.literal("ACK"), z.literal("MESSAGE")]),
});

export const TriggerEnvironmentSchema = z.enum(["live", "development"]);
export type TriggerEnvironment = z.infer<typeof TriggerEnvironmentSchema>;
