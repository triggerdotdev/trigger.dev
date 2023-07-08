import {
  CreateCompletionResponseUsage,
  CreateEmbeddingResponseUsage,
} from "openai";

export function createTaskUsageProperties(
  usage:
    | CreateCompletionResponseUsage
    | CreateEmbeddingResponseUsage
    | undefined
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
