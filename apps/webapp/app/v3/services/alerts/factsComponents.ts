import { compositeComponentSchema, type CompositeFacts } from "@internal/alert-contracts";

export type FactsComponents = CompositeFacts["components"];

export function parseEvaluatorStateComponents(
  evaluatorState: Record<string, unknown> | null | undefined
): FactsComponents | null {
  return evaluatorState ? parseComponents(evaluatorState.lastComponents) : null;
}

export function parseComponentsFromFacts(facts: Record<string, unknown>): FactsComponents | null {
  return parseComponents(facts.components);
}

function parseComponents(components: unknown): FactsComponents | null {
  if (typeof components !== "object" || !components) return null;
  const result: FactsComponents = {};
  for (const [key, entry] of Object.entries(components as Record<string, unknown>)) {
    const parsed = compositeComponentSchema.safeParse(entry);
    if (parsed.success) result[key] = parsed.data;
  }
  return Object.keys(result).length > 0 ? result : null;
}
