import { z } from "zod";
import { type AlertCapability, type Condition, evaluationOutcomeSchema } from "./schemas.js";

export const LEGACY_HEALTH_COMPONENTS = ["health.flow", "health.execution", "health.liveness"];

export function selectedComponents(
  capability: AlertCapability,
  condition: Condition | undefined
): string[] {
  const compositeOf = capability.binding.compositeOf ?? [];
  const chosen =
    condition?.kind === "state" && condition.components
      ? condition.components
      : capability.area === "limits"
        ? compositeOf
        : LEGACY_HEALTH_COMPONENTS;
  return compositeOf.filter((key) => chosen.includes(key));
}

/** Legacy components keep their short keys: persisted evaluator state depends on them. */
export function componentFactsKey(key: string): string {
  return LEGACY_HEALTH_COMPONENTS.includes(key) ? key.replace(/^health\./, "") : key;
}

export const compositeComponentSchema = z
  .object({
    outcome: evaluationOutcomeSchema,
    effectiveParams: z.record(z.string(), z.number()),
    signals: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    offendingGroups: z.array(z.string()).optional(),
    unavailableReason: z.string().optional(),
  })
  .passthrough();
export type CompositeComponent = z.infer<typeof compositeComponentSchema>;

export const compositeFactsSchema = z
  .object({
    components: z.record(z.string(), compositeComponentSchema),
    unavailableComponents: z.array(z.string()).optional(),
    failedComponents: z.array(z.string()).optional(),
    unavailableReason: z.string().optional(),
  })
  .passthrough();
export type CompositeFacts = z.infer<typeof compositeFactsSchema>;
