import type { DeploymentLogEntry } from "~/components/runs/v3/deploymentLogsCache";

// BuildKit reports a missing registry cache as a step ERROR, then builds without it.
// That always happens on a project's first build, so keep the line for history but
// don't let it read (or count) as a failure.
const REGISTRY_CACHE_MISS =
  /^#\d+ ERROR: failed to configure registry cache importer: \S+: not found$/;

export function classifyDeploymentLog(entry: DeploymentLogEntry): DeploymentLogEntry {
  if (entry.level === "error" && REGISTRY_CACHE_MISS.test(entry.message.trim())) {
    return { ...entry, level: "info" };
  }
  return entry;
}
