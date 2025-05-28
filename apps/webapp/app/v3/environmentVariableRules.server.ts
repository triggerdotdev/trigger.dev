import { type EnvironmentVariable } from "./environmentVariables/repository";

type VariableRule =
  | { type: "exact"; key: string }
  | { type: "prefix"; prefix: string }
  | { type: "whitelist"; key: string };

const blacklistedVariables: VariableRule[] = [
  { type: "exact", key: "TRIGGER_SECRET_KEY" },
  { type: "exact", key: "TRIGGER_API_URL" },
  { type: "prefix", prefix: "OTEL_" },
  { type: "whitelist", key: "OTEL_LOG_LEVEL" },
];

export function removeBlacklistedVariables(
  variables: EnvironmentVariable[]
): EnvironmentVariable[] {
  return variables.filter((v) => {
    const whitelisted = blacklistedVariables.find(
      (bv) => bv.type === "whitelist" && bv.key === v.key
    );
    if (whitelisted) {
      return true;
    }

    const exact = blacklistedVariables.find((bv) => bv.type === "exact" && bv.key === v.key);
    if (exact) {
      return false;
    }

    const prefix = blacklistedVariables.find(
      (bv) => bv.type === "prefix" && v.key.startsWith(bv.prefix)
    );
    if (prefix) {
      return false;
    }

    return true;
  });
}
