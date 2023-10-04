import { UIMatch } from "@remix-run/react";
import { MatchedProject, useOptionalProject } from "./useProject";
import { AppData } from "~/utils/appData";
import { Handle } from "~/utils/handle";

export type ProjectJobEnvironment = MatchedProject["environments"][number];

export function useEnvironments<T = AppData>(matches?: UIMatch<T, Handle>[]) {
  const project = useOptionalProject(matches);
  if (!project) return;

  return project.environments;
}

export function useDevEnvironment<T = AppData>(matches?: UIMatch<T, Handle>[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "DEVELOPMENT");
}

export function useProdEnvironment<T = AppData>(matches?: UIMatch<T, Handle>[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "PRODUCTION");
}
