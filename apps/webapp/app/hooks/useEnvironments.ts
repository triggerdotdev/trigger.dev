import { UIMatch } from "@remix-run/react";
import { MatchedProject, useOptionalProject } from "./useProject";
import { useUser } from "./useUser";

export type ProjectJobEnvironment = MatchedProject["environments"][number];

export function useEnvironments(matches?: UIMatch[]) {
  const project = useOptionalProject(matches);
  if (!project) return;

  return project.environments;
}
