import OpenAI from "openai";
import { z } from "zod";

export function createTaskUsageProperties(
  usage: OpenAI.Completions.CompletionUsage | OpenAI.CreateEmbeddingResponse.Usage | undefined
) {
  if (!usage) {
    return;
  }

  return [
    {
      label: "Prompt Usage",
      text: String(usage.prompt_tokens),
    },
    ...("completion_tokens" in usage
      ? [
          {
            label: "Completion Usage",
            text: String(usage.completion_tokens),
          },
        ]
      : []),
    {
      label: "Total Usage",
      text: String(usage.total_tokens),
    },
  ];
}

const OpenAIErrorSchema = z.object({
  response: z.object({
    data: z.object({
      error: z.object({
        code: z.string().nullable().optional(),
        message: z.string(),
        type: z.string(),
      }),
    }),
  }),
});

export function onTaskError(error: unknown) {
  const openAIError = OpenAIErrorSchema.safeParse(error);

  if (!openAIError.success) {
    return;
  }

  const { message, code, type } = openAIError.data.response.data.error;

  return new Error(`${type}: ${message}${code ? ` (${code})` : ""}`);
}
