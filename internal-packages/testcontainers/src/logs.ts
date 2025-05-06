import { env, isCI } from "std-env";
import { TaskContext } from "vitest";
import { DockerDiagnostics, getDockerDiagnostics } from "./docker";
import { StartedTestContainer } from "testcontainers";

let setupOrder = 0;

export function logSetup(resource: string, metadata: Record<string, unknown>) {
  const order = setupOrder++;

  if (!isCI) {
    return;
  }

  console.log(
    JSON.stringify({
      type: "setup",
      order,
      resource,
      timestamp: new Date().toISOString(),
      ...metadata,
    })
  );
}

export function getContainerMetadata(container: StartedTestContainer) {
  return {
    containerName: container.getName(),
    containerId: container.getId().slice(0, 12),
    containerNetworkNames: container.getNetworkNames(),
  };
}

export function getTaskMetadata(task: TaskContext["task"]) {
  return {
    testName: task.name,
  };
}

let cleanupOrder = 0;
let activeCleanups = 0;

/**
 * Logs the cleanup of a resource.
 * @param resource - The resource that is being cleaned up.
 * @param promise - The cleanup promise to await..
 */
export async function logCleanup(
  resource: string,
  promise: Promise<unknown>,
  metadata: Record<string, unknown> = {}
) {
  const start = new Date();
  const order = cleanupOrder++;
  const activeAtStart = ++activeCleanups;

  let error: unknown = null;

  try {
    await promise;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const end = new Date();
  const durationMs = end.getTime() - start.getTime();
  const activeAtEnd = --activeCleanups;
  const parallel = activeAtStart > 1 || activeAtEnd > 0;

  if (!isCI) {
    return;
  }

  let dockerDiagnostics: DockerDiagnostics = {};

  // Only run docker diagnostics if there was an error or cleanup took longer than 5s
  if (error || durationMs > 5000 || env.DOCKER_DIAGNOSTICS) {
    try {
      dockerDiagnostics = await getDockerDiagnostics();
    } catch (diagnosticErr) {
      console.error("Failed to get docker diagnostics:", diagnosticErr);
    }
  }

  console.log(
    JSON.stringify({
      type: "cleanup",
      order,
      resource,
      durationMs,
      start: start.toISOString(),
      end: end.toISOString(),
      parallel,
      error,
      activeAtStart,
      activeAtEnd,
      ...metadata,
      ...dockerDiagnostics,
    })
  );
}
