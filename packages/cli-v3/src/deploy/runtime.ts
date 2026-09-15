import type { BuildRuntime } from "@trigger.dev/core/v3";

export function resolveDeploymentRuntime({
  configuredRuntime,
  runtimeWasExplicit,
  projectDefaultRuntime,
}: {
  configuredRuntime: BuildRuntime;
  runtimeWasExplicit: boolean;
  projectDefaultRuntime: BuildRuntime | null | undefined;
}): BuildRuntime {
  return !runtimeWasExplicit && projectDefaultRuntime ? projectDefaultRuntime : configuredRuntime;
}
