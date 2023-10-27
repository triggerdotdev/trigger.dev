import { UIMatch } from "@remix-run/react";
import { MatchedProject, useOptionalProject } from "./useProject";
import { useUser } from "./useUser";

export type ProjectJobEnvironment = MatchedProject["environments"][number];

export function useEnvironments(matches?: UIMatch[]) {
  const project = useOptionalProject(matches);
  if (!project) return;

  return project.environments;
}

export function useDevEnvironment(matches?: UIMatch[]) {
  const user = useUser();
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find(
    (environment) => environment.type === "DEVELOPMENT" && environment.userId === user.id
  );
}

export function useProdEnvironment(matches?: UIMatch[]) {
  const environments = useEnvironments(matches);
  if (!environments) return;

  return environments.find((environment) => environment.type === "PRODUCTION");
}
