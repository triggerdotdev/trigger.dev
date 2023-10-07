import { UIMatch } from "@remix-run/react";
import { MatchedProject, useOptionalProject } from "./useProject";
import { Handle } from "~/utils/handle";

export type ProjectJobEnvironment = MatchedProject["environments"][number];

export function useEnvironments(matches?: UIMatch<unknown, Handle>[]) {
  const project = useOptionalProject(matches);
  if (!project) return;

  return project.environments;
}

export function useDevEnvironment(matches?: UIMatch<unknown, Handle>[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "DEVELOPMENT");
}

export function useProdEnvironment(matches?: UIMatch<unknown, Handle>[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "PRODUCTION");
}
