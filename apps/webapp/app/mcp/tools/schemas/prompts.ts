import { z } from "zod";
import { CommonProjectsInput } from "./common";
import { Period } from "./models";

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

const BoundedSlug = z.string().min(1).max(256).describe("The prompt slug");

export const GetPromptInput = CommonProjectsInput.extend({
  slug: BoundedSlug,
  label: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Resolve the version this label points to, e.g. "current" (the default). An active dashboard override always wins over a label.'
    ),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Resolve this exact version number instead of a label"),
});

export const ListGenerationsInput = CommonProjectsInput.extend({
  slug: BoundedSlug,
  period: Period,
  versions: z
    .array(z.number().int().positive())
    .max(20)
    .optional()
    .describe("Only generations from these prompt versions"),
  limit: z.number().int().min(1).max(100).default(25).describe("How many to return (default 25)"),
  cursor: z
    .string()
    .max(1_024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "not a cursor from list_prompt_generations")
    .optional()
    .describe("The cursor from a previous call, to get the next page of older generations"),
});

export const ReactivateOverrideInput = PromptSlugInput.extend({
  version: Version("The dashboard-sourced version number to reactivate as override"),
});
