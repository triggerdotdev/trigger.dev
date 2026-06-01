import { z } from "zod";

// Valid section IDs that can have their collapsed state toggled
export const SideMenuSectionIdSchema = z.enum([
  "ai",
  "manage",
  "metrics",
  "deployments",
  "project-settings",
  "tasks",
]);

// Inferred type from the schema
export type SideMenuSectionId = z.infer<typeof SideMenuSectionIdSchema>;
