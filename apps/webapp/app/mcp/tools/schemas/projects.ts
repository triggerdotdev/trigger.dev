import { z } from "zod";

const ProjectRef = z
  .string()
  .min(1)
  .describe("The project ref, starts with proj_. list_projects lists your projects.");

export const RenameProjectInput = z.object({
  projectRef: ProjectRef,
  name: z
    .string()
    .max(1000)
    .describe("The new project name, 3 to 50 characters. Leading and trailing spaces are removed."),
});

export const DeleteProjectInput = z.object({ projectRef: ProjectRef });
