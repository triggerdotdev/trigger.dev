import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const Period = z
  .string()
  .regex(/^\d{1,4}[mhdw]$/, "a period is a number and m, h, d or w, e.g. 1h or 7d")
  .default("7d")
  .describe('How far back to look, e.g. "1h", "1d" or "30d". Defaults to 7d.');

export const ListModelsInput = CommonProjectsInput.extend({
  provider: z
    .string()
    .max(64)
    .optional()
    .describe("Only this provider's models, e.g. openai or anthropic"),
  search: z
    .string()
    .max(100)
    .optional()
    .describe("Only models whose name contains this text (case-insensitive)"),
  limit: z.number().int().min(1).max(200).default(50).describe("How many to return (default 50)"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe("How many to skip, to get the next page"),
});

export const GetModelInput = CommonProjectsInput.extend({
  modelId: z
    .string()
    .regex(/^llm_model_[A-Za-z0-9]{1,64}$/, "a model id starts with llm_model_")
    .describe("The model id, starting with llm_model_. Use list_models to find it."),
});

export const ModelUsageInput = CommonProjectsInput.extend({ period: Period });
