import { isMacOS, isWindows } from "std-env";

export function normalizeDockerHostUrl(url: string) {
  const $url = new URL(url);

  if ($url.hostname === "localhost") {
    $url.hostname = getDockerHostDomain();
  }

  return $url.toString();
}

export function getDockerHostDomain() {
  return isMacOS || isWindows ? "host.docker.internal" : "localhost";
}

/** Extract the W3C traceparent string from an untyped trace context record */
export function extractTraceparent(traceContext?: Record<string, unknown>): string | undefined {
  if (
    traceContext &&
    "traceparent" in traceContext &&
    typeof traceContext.traceparent === "string"
  ) {
    return traceContext.traceparent;
  }
  return undefined;
}

export function getRunnerId(runId: string, attemptNumber?: number) {
  const parts = ["runner", runId.replace("run_", "")];

  if (attemptNumber && attemptNumber > 1) {
    parts.push(`attempt-${attemptNumber}`);
  }

  return parts.join("-");
}

/**
 * The attempt a cold start's runner was created for, read back from its id (`getRunnerId`).
 * Undefined for any other id, e.g. a restore runner's, which carries a checkpoint instead.
 */
export function attemptOfRunnerId(runnerId: string, runFriendlyId: string): number | undefined {
  const base = getRunnerId(runFriendlyId);
  if (runnerId === base) {
    return 1;
  }
  const match = runnerId.startsWith(base)
    ? /^-attempt-(\d+)$/.exec(runnerId.slice(base.length))
    : null;
  return match ? Number(match[1]) : undefined;
}

/** Derive a unique runnerId for a restore cycle using the checkpoint suffix */
export function getRestoreRunnerId(runFriendlyId: string, checkpointId: string) {
  const runIdShort = runFriendlyId.replace("run_", "");
  const checkpointSuffix = checkpointId.slice(-8);
  return `runner-${runIdShort}-${checkpointSuffix}`;
}
