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

export function getRunnerId(runId: string, attemptNumber?: number) {
  const parts = ["runner", runId.replace("run_", "")];

  if (attemptNumber && attemptNumber > 1) {
    parts.push(`attempt-${attemptNumber}`);
  }

  return parts.join("-");
}
