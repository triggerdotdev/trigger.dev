import { type EnvironmentVariable } from "./environmentVariables/repository";

type VariableRule =
  | { type: "exact"; key: string }
  | { type: "prefix"; prefix: string }
  | { type: "whitelist"; key: string };

const blacklistedVariables: VariableRule[] = [
  { type: "exact", key: "TRIGGER_SECRET_KEY" },
  { type: "exact", key: "TRIGGER_API_URL" },
];

const additionalExternalSyncReservedKeys = ["TRIGGER_VERSION", "TRIGGER_PREVIEW_BRANCH"];

export function isBlacklistedVariable(key: string): boolean {
  const whitelisted = blacklistedVariables.find((bv) => bv.type === "whitelist" && bv.key === key);
  if (whitelisted) {
    return false;
  }

  const exact = blacklistedVariables.find((bv) => bv.type === "exact" && bv.key === key);
  if (exact) {
    return true;
  }

  const prefix = blacklistedVariables.find(
    (bv) => bv.type === "prefix" && key.startsWith(bv.prefix)
  );
  if (prefix) {
    return true;
  }

  return false;
}

// Keys that must never be synced from an external integration (e.g. Vercel). Superset of
// the repository blacklist so submitting a reserved key doesn't get the whole batch rejected.
export function isReservedForExternalSync(key: string): boolean {
  return isBlacklistedVariable(key) || additionalExternalSyncReservedKeys.includes(key);
}

export function removeBlacklistedVariables(
  variables: EnvironmentVariable[]
): EnvironmentVariable[] {
  return variables.filter((v) => !isBlacklistedVariable(v.key));
}
