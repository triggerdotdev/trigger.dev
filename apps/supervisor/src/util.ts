export function getDockerHostDomain() {
  const isMacOs = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  return isMacOs || isWindows ? "host.docker.internal" : "localhost";
}

export function getRunnerId(runId: string) {
  return `runner-${runId.replace("run_", "")}`;
}
