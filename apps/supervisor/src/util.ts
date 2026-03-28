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
