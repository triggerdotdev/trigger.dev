import {
  apiClientManager,
  type ApiRequestOptions,
  type CreatePromptOverrideRequestBody,
  type ListPromptsResponseBody,
  type ListPromptVersionsResponseBody,
  type PromptOkResponseBody,
  type PromptOverrideCreatedResponseBody,
  type ResolvePromptResponseBody,
  type UpdatePromptOverrideRequestBody,
} from "@trigger.dev/core/v3";
import type { ResolvedPrompt } from "./prompt.js";

function makeToAISDKTelemetry(
  slug: string,
  promptId: string,
  version: number,
  labels: string[],
  model?: string,
  input?: string
) {
  return function toAISDKTelemetry(additionalMetadata?: Record<string, string>) {
    return {
      experimental_telemetry: {
        isEnabled: true as const,
        metadata: {
          "prompt.slug": slug,
          "prompt.id": promptId,
          "prompt.version": String(version),
          "prompt.labels": labels.join(", "),
          ...(model ? { "prompt.model": model } : {}),
          ...(input ? { "prompt.input": input } : {}),
          ...additionalMetadata,
        },
      },
    };
  };
}

/**
 * Resolve a prompt by slug, calling the API to get the current version's
 * compiled text. Works both inside and outside of a task context — requires
 * an API client to be configured (via `configure()` or task runtime).
 */
export async function resolvePrompt(
  slug: string,
  variables?: Record<string, unknown>,
  options?: { label?: string; version?: number; requestOptions?: ApiRequestOptions }
): Promise<ResolvedPrompt> {
  const apiClient = apiClientManager.clientOrThrow();
  const vars = variables ?? {};
  const response = await apiClient.resolvePrompt(slug, {
    variables: vars,
    label: options?.label,
    version: options?.version,
  });

  const data = response.data;
  const inputJson = Object.keys(vars).length > 0 ? JSON.stringify(vars) : undefined;

  return {
    promptId: data.promptId,
    version: data.version,
    labels: data.labels,
    text: data.text ?? "",
    model: data.model ?? undefined,
    config: (data.config as Record<string, unknown>) ?? undefined,
    toAISDKTelemetry: makeToAISDKTelemetry(
      data.slug,
      data.promptId,
      data.version,
      data.labels,
      data.model ?? undefined,
      inputJson
    ),
  };
}

/** List all prompts in the current environment. */
export function listPrompts(
  requestOptions?: ApiRequestOptions
): Promise<ListPromptsResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.listPrompts(requestOptions);
}

/** List all versions for a prompt. */
export function listPromptVersions(
  slug: string,
  requestOptions?: ApiRequestOptions
): Promise<ListPromptVersionsResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.listPromptVersions(slug, requestOptions);
}

/** Promote a code-deployed version to be the current version. */
export async function promotePromptVersion(
  slug: string,
  version: number,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.promotePromptVersion(slug, { version }, requestOptions);
}

/** Create an override — a dashboard/API edit that takes priority over the deployed version. */
export async function createPromptOverride(
  slug: string,
  body: CreatePromptOverrideRequestBody,
  requestOptions?: ApiRequestOptions
): Promise<PromptOverrideCreatedResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.createPromptOverride(slug, body, requestOptions);
}

/** Update the active override's content or model. */
export async function updatePromptOverride(
  slug: string,
  body: UpdatePromptOverrideRequestBody,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.updatePromptOverride(slug, body, requestOptions);
}

/** Remove the active override, reverting to the current deployed version. */
export async function removePromptOverride(
  slug: string,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.removePromptOverride(slug, requestOptions);
}

/** Reactivate a previously removed override version. */
export async function reactivatePromptOverride(
  slug: string,
  version: number,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.reactivatePromptOverride(slug, { version }, requestOptions);
}
