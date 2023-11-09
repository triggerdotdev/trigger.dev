import { z } from "zod";

export const JobVersionDispatchableSchema = z.object({
  type: z.literal("JOB_VERSION"),
  id: z.string(),
});

export const DynamicTriggerDispatchableSchema = z.object({
  type: z.literal("DYNAMIC_TRIGGER"),
  id: z.string(),
});

export const EphemeralDispatchableSchema = z.object({
  type: z.literal("EPHEMERAL"),
  url: z.string(),
});

export const DispatchableSchema = z.discriminatedUnion("type", [
  JobVersionDispatchableSchema,
  DynamicTriggerDispatchableSchema,
  EphemeralDispatchableSchema,
]);
