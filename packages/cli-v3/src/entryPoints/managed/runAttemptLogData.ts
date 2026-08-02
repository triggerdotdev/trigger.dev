type WorkloadRunAttemptStartData = {
  run: unknown;
  snapshot: unknown;
  execution: unknown;
  envVars: Record<string, string>;
};

export function getWorkloadRunAttemptStartLogData<T extends WorkloadRunAttemptStartData>(
  start: T
): Pick<T, "run" | "snapshot" | "execution"> {
  const { run, snapshot, execution } = start;
  return { run, snapshot, execution };
}
