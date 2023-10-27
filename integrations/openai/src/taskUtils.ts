import OpenAI from "openai";
import { OpenAIRequestOptions } from "./types";
import { redactString } from "@trigger.dev/sdk";

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

export function onTaskError(error: unknown) {
  return;
}

export function createBackgroundFetchUrl(
  client: OpenAI,
  endpoint: string,
  defaultQuery: OpenAIRequestOptions["query"] = {},
  options: OpenAIRequestOptions = {}
) {
  let baseURL = client.baseURL ?? "https://api.openai.com/v1";
  if (baseURL.endsWith("/")) {
    baseURL = baseURL.slice(0, -1);
  }

  const path = options.path ?? endpoint;

  const url = new URL(`${baseURL}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        url.searchParams.append(key, value);
      }
    }
  }

  for (const [key, value] of Object.entries(defaultQuery)) {
    if (value !== undefined) {
      url.searchParams.append(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }

  return url.href;
}

export function createBackgroundFetchHeaders(
  client: OpenAI,
  idempotencyKey: string,
  defaultHeaders: OpenAIRequestOptions["headers"] = {},
  options: OpenAIRequestOptions = {}
) {
  return {
    "Content-Type": "application/json",
    Authorization: redactString`Bearer ${client.apiKey}`,
    ...(client.organization ? { "OpenAI-Organization": client.organization } : {}),
    "Idempotency-Key": options.idempotencyKey ?? idempotencyKey,
    ...(options.headers ?? {}),
    ...defaultHeaders,
  };
}

export const backgroundTaskRetries = {
  "500-599": {
    strategy: "backoff",
    limit: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 1.8,
    randomize: true,
  },
  "429": {
    strategy: "backoff",
    limit: 10,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 60000,
    factor: 2,
    randomize: true,
  },
  "408-409": {
    strategy: "backoff",
    limit: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 60000,
    factor: 2,
    randomize: true,
  },
} as const;
