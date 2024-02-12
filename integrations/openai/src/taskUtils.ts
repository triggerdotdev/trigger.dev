import OpenAI, { APIError } from "openai";
import { OpenAIRequestOptions } from "./types";
import { redactString } from "@trigger.dev/sdk";
import { calculateResetAtUtil } from "@trigger.dev/integration-kit";
import { FetchRetryOptions } from "@trigger.dev/integration-kit";

export function createImageTaskOutputProperties(
  response: OpenAI.ImagesResponse | undefined,
  headers?: Headers | undefined
) {
  if (!response && !headers) {
    return;
  }

  return [...createTaskImageProperties(response), ...createTaskRateLimitProperties(headers)];
}

function createTaskImageProperties(response: OpenAI.ImagesResponse | undefined) {
  if (!response) {
    return [];
  }

  const imageUrls = response.data.map((image) => image.url).filter(Boolean) as string[];

  if (imageUrls.length === 0) {
    return [];
  }

  return [
    {
      label: "Images",
      text: imageUrls[0],
      imageUrl: imageUrls,
    },
  ];
}

export function createTaskOutputProperties(
  usage: OpenAI.Completions.CompletionUsage | OpenAI.CreateEmbeddingResponse.Usage | undefined,
  headers?: Headers | undefined
) {
  if (!usage && !headers) {
    return;
  }

  return [...createTaskUsageProperties(usage), ...createTaskRateLimitProperties(headers)];
}

function createTaskUsageProperties(
  usage: OpenAI.Completions.CompletionUsage | OpenAI.CreateEmbeddingResponse.Usage | undefined
) {
  if (!usage) {
    return [];
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
  ];
}

function createTaskRateLimitProperties(headers: Headers | undefined) {
  if (!headers) {
    return [];
  }

  const remainingRequests = headers.get("x-ratelimit-remaining-requests");
  const remainingTokens = headers.get("x-ratelimit-remaining-tokens");

  const resetRequests = headers.get("x-ratelimit-reset-requests");
  const resetTokens = headers.get("x-ratelimit-reset-tokens");

  return [
    ...(remainingRequests
      ? [
          {
            label: "Remaining Requests",
            text: remainingRequests ?? "Unknown",
          },
        ]
      : []),
    ...(resetRequests
      ? [
          {
            label: "Reset Requests",
            text: resetRequests ?? "Unknown",
          },
        ]
      : []),
    ...(remainingTokens
      ? [
          {
            label: "Remaining Tokens",
            text: remainingTokens ?? "Unknown",
          },
        ]
      : []),
    ...(resetTokens
      ? [
          {
            label: "Reset Tokens",
            text: resetTokens ?? "Unknown",
          },
        ]
      : []),
  ];
}

export function handleOpenAIError(error: unknown) {
  if (error instanceof APIError) {
    const isErrorRetryable = () => {
      if (typeof error.status !== "number") {
        return false;
      }

      if (error.status === 429 && error.type === "insufficient_quota") {
        return false;
      }

      return (
        //sometimes OpenAI returns a 400 that when retried becomes a 200…
        error.status === 400 ||
        error.status === 429 ||
        error.status === 408 ||
        error.status === 409 ||
        (error.status >= 500 && error.status <= 599)
      );
    };

    const calculateRetryAt = () => {
      if (error.status !== 429) {
        return;
      }

      if (!error.headers) {
        return;
      }

      const remainingRequests = error.headers["x-ratelimit-remaining-requests"];
      const requestResets = error.headers["x-ratelimit-reset-requests"];

      if (typeof remainingRequests === "string" && Number(remainingRequests) === 0) {
        return calculateResetAt(requestResets);
      }

      const remainingTokens = error.headers["x-ratelimit-remaining-tokens"];
      const tokensResets = error.headers["x-ratelimit-reset-tokens"];

      if (typeof remainingTokens === "string" && Number(remainingTokens) === 0) {
        return calculateResetAt(tokensResets);
      }
    };

    return {
      error,
      skipRetrying: !isErrorRetryable(),
      retryAt: calculateRetryAt(),
    };
  }

  return error as Error;
}

// This takes a string in the format of 1s or 6m59s, 1h6m18s and calculates the date
// If the string is invalid, it returns undefined
// If the string is null or undefined, it returns undefined
export function calculateResetAt(
  resets: string | null | undefined,
  now: Date = new Date()
): Date | undefined {
  return calculateResetAtUtil(resets, "iso_8601_duration_openai_variant", now);
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

export const backgroundTaskRetries: FetchRetryOptions = {
  "500-599": {
    strategy: "backoff",
    limit: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 2,
    randomize: true,
  },
  "429": {
    strategy: "backoff",
    limit: 0,
    bodyFilter: {
      error: {
        code: ["insufficient_quota"],
      },
    },
  },
  "429,429": {
    strategy: "headers",
    limitHeader: "x-ratelimit-limit-requests",
    remainingHeader: "x-ratelimit-remaining-requests",
    resetHeader: "x-ratelimit-reset-requests",
    resetFormat: "iso_8601_duration_openai_variant",
    bodyFilter: {
      error: {
        code: ["rate_limit_exceeded"],
        type: ["requests"],
      },
    },
  },
  "429,429,429": {
    strategy: "headers",
    limitHeader: "x-ratelimit-limit-tokens",
    remainingHeader: "x-ratelimit-remaining-tokens",
    resetHeader: "x-ratelimit-reset-tokens",
    resetFormat: "iso_8601_duration_openai_variant",
    bodyFilter: {
      error: {
        code: ["rate_limit_exceeded"],
        type: ["tokens"],
      },
    },
  },
  "408-409": {
    strategy: "backoff",
    limit: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 60000,
    factor: 2,
    randomize: true,
  },
};

type KeysEnum<T> = { [P in keyof Required<T>]: true };

const requestOptionsKeys: KeysEnum<OpenAIRequestOptions> = {
  method: true,
  path: true,
  query: true,
  headers: true,
  idempotencyKey: true,
};

export const isRequestOptions = (obj: unknown): obj is OpenAIRequestOptions => {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !isEmptyObj(obj) &&
    Object.keys(obj).every((k) => hasOwn(requestOptionsKeys, k))
  );
};

function isEmptyObj(obj: Object | null | undefined): boolean {
  if (!obj) return true;
  for (const _k in obj) return false;
  return true;
}

function hasOwn(obj: Object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
