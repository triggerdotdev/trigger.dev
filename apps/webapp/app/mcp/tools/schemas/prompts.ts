import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const ListPromptsInput = CommonProjectsInput;

export const PromptSlugInput = CommonProjectsInput.extend({
  slug: z.string().describe("The prompt slug"),
});
