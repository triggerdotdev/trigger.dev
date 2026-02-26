import { z } from "zod";

// Valid section IDs that can have their collapsed state toggled
export const SideMenuSectionIdSchema = z.enum(["manage", "metrics", "project-settings"]);

// Inferred type from the schema
export type SideMenuSectionId = z.infer<typeof SideMenuSectionIdSchema>;
