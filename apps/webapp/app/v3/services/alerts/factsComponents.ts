import { z } from "zod";

export type FactsComponents = Record<
  "flow" | "execution" | "liveness",
  { outcome: "met" | "not_met" | "unavailable"; effectiveParams: Record<string, number> }
>;

const COMPONENT_KEYS = ["flow", "execution", "liveness"] as const;

const componentEntrySchema = z.object({
  outcome: z.enum(["met", "not_met", "unavailable"]),
  effectiveParams: z.record(z.string(), z.number()),
});

const lastComponentsSchema = z.object({
  lastComponents: z.record(z.enum(["flow", "execution", "liveness"]), componentEntrySchema),
});

export function parseEvaluatorStateComponents(
  evaluatorState: Record<string, unknown> | null | undefined
): FactsComponents | null {
  if (!evaluatorState) return null;
  const parsed = lastComponentsSchema.safeParse(evaluatorState);
  if (!parsed.success) return null;
  return parsed.data.lastComponents as FactsComponents;
}

export function parseComponentsFromFacts(facts: Record<string, unknown>): FactsComponents | null {
  if (typeof facts.components !== "object" || !facts.components) return null;
  const raw = facts.components as Record<string, unknown>;
  const result: Record<string, { outcome: string; effectiveParams: Record<string, number> }> = {};
  for (const k of COMPONENT_KEYS) {
    const entry = raw[k];
    if (entry && typeof entry === "object" && "outcome" in (entry as Record<string, unknown>)) {
      result[k] = entry as { outcome: string; effectiveParams: Record<string, number> };
    }
  }
  return Object.keys(result).length > 0 ? (result as FactsComponents) : null;
}
