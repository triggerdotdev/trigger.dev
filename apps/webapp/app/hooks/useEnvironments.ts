import { RouteMatch } from "@remix-run/react";
import { MatchedProject, useOptionalProject } from "./useProject";

export type ProjectJobEnvironment = MatchedProject["environments"][number];

export function useEnvironments(matches?: RouteMatch[]) {
  const project = useOptionalProject(matches);
  if (!project) return;

  return project.environments;
}

export function useDevEnvironment(matches?: RouteMatch[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "DEVELOPMENT");
}

export function useProdEnvironment(matches?: RouteMatch[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "PRODUCTION");
}
