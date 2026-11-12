import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const ListPromptsInput = CommonProjectsInput;

export const PromptSlugInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
});

const Version = (description: string) => z.coerce.number().int().positive().describe(description);

export const PromoteInput = PromptSlugInput.extend({
  version: Version("The version number to promote to current"),
});

export const CreateOverrideInput = PromptSlugInput.extend({
  textContent: z.string().describe("The full text content for the override"),
  model: z.string().optional().describe("Optional model override"),
  commitMessage: z.string().optional().describe("Optional commit message describing the change"),
});

export const UpdateOverrideInput = PromptSlugInput.extend({
  textContent: z.string().optional().describe("Updated text content"),
  model: z.string().optional().describe("Updated model"),
  commitMessage: z.string().optional().describe("Commit message describing the change"),
});

export const ReactivateOverrideInput = PromptSlugInput.extend({
  version: Version("The dashboard-sourced version number to reactivate as override"),
});
