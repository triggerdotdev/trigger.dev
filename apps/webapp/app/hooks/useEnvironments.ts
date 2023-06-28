import { DEV_ENVIRONMENT, LIVE_ENVIRONMENT } from "~/consts";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { useMatchesData } from "~/utils";
import { MatchedProject, useOptionalProject } from "./useProject";

export type ProjectJobEnvironment = MatchedProject["environments"][number];

export function useEnvironments() {
  const project = useOptionalProject();

  if (!project) {
    return undefined;
  }

  return project.environments;
}

export function useDevEnvironment() {
  const environments = useEnvironments();
  if (!environments) return;

  return environments.find((environment) => environment.type === "DEVELOPMENT");
}

export function useProdEnvironment() {
  const environments = useEnvironments();
  if (!environments) return;

  return environments.find((environment) => environment.type === "PRODUCTION");
}
