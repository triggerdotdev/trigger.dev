import { GROUP_CAPABILITY_KEY } from "@internal/alert-contracts";

export function groupFiredDetail(capabilityKey: string, facts: unknown): string | null {
  if (capabilityKey !== GROUP_CAPABILITY_KEY) return null;
  const members = (facts as { members?: Record<string, { outcome?: string; name?: string }> })
    ?.members;
  const names = Object.values(members ?? {})
    .filter((m) => m.outcome === "met" && typeof m.name === "string")
    .map((m) => m.name);
  return names.length ? `Fired: ${names.join(", ")}` : null;
}
