export function getDockerHostDomain() {
  const isMacOs = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  return isMacOs || isWindows ? "host.docker.internal" : "localhost";
}

export function getRunnerId(runId: string, attemptNumber?: number) {
  const parts = ["runner", runId.replace("run_", "")];

  if (attemptNumber && attemptNumber > 1) {
    parts.push(`attempt-${attemptNumber}`);
  }

  return parts.join("-");
}
