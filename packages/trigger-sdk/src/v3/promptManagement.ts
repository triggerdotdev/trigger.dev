import {
  accessoryAttributes,
  apiClientManager,
  SemanticInternalAttributes,
  type ApiRequestOptions,
  type CreatePromptOverrideRequestBody,
  type ListPromptsResponseBody,
  type ListPromptVersionsResponseBody,
  type PromptOkResponseBody,
  type PromptOverrideCreatedResponseBody,
  type UpdatePromptOverrideRequestBody,
} from "@trigger.dev/core/v3";
import type { AnyPromptHandle, PromptIdentifier, PromptVariables, ResolvedPrompt } from "./prompt.js";
import { tracer } from "./tracer.js";

function promptSpanOptions(name: string, slug: string) {
  return {
    tracer,
    name,
    icon: "tabler-file-text-ai",
    attributes: {
      [SemanticInternalAttributes.STYLE_ICON]: "tabler-file-text-ai",
      ...accessoryAttributes({
        items: [{ text: slug, variant: "normal" as const }],
        style: "codepath",
      }),
    },
  };
}

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
export async function resolvePrompt<TPromptHandle extends AnyPromptHandle = AnyPromptHandle>(
  slug: PromptIdentifier<TPromptHandle>,
  variables?: PromptVariables<TPromptHandle>,
  options?: { label?: string; version?: number; requestOptions?: ApiRequestOptions }
): Promise<ResolvedPrompt> {
  const apiClient = apiClientManager.clientOrThrow();
  const vars = variables ?? {};
  const response = await apiClient.resolvePrompt(
    slug,
    {
      variables: vars,
      label: options?.label,
      version: options?.version,
    },
    {
      ...promptSpanOptions("prompts.resolve()", slug),
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "tabler-file-text-ai",
        [SemanticInternalAttributes.ENTITY_TYPE]: "prompt",
        [SemanticInternalAttributes.ENTITY_ID]: slug,
        ...accessoryAttributes({
          items: [{ text: slug, variant: "normal" as const }],
          style: "codepath",
        }),
      },
      onResponseBody: (body, span) => {
        span.setAttribute("prompt.version", body.data.version);
        span.setAttribute("prompt.slug", body.data.slug);
        span.setAttribute("prompt.labels", body.data.labels.join(", "));
        if (body.data.model) span.setAttribute("prompt.model", body.data.model);
        if (body.data.text) span.setAttribute("prompt.text", body.data.text);
        if (vars && Object.keys(vars).length > 0) {
          span.setAttribute("prompt.input", JSON.stringify(vars));
        }
      },
    }
  );

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
  return apiClient.listPrompts({
    tracer,
    name: "prompts.list()",
    icon: "tabler-file-text-ai",
    attributes: {
      [SemanticInternalAttributes.STYLE_ICON]: "tabler-file-text-ai",
    },
    onResponseBody: (body, span) => {
      span.setAttribute("prompt.count", body.data.length);
    },
  });
}

/** List all versions for a prompt. */
export function listPromptVersions(
  slug: string,
  requestOptions?: ApiRequestOptions
): Promise<ListPromptVersionsResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.listPromptVersions(slug, {
    ...promptSpanOptions("prompts.versions()", slug),
    onResponseBody: (body, span) => {
      span.setAttribute("prompt.slug", slug);
      span.setAttribute("prompt.versions.count", body.data.length);
    },
  });
}

/** Promote a code-deployed version to be the current version. */
export async function promotePromptVersion(
  slug: string,
  version: number,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.promotePromptVersion(slug, { version }, {
    ...promptSpanOptions("prompts.promote()", slug),
    attributes: {
      ...promptSpanOptions("prompts.promote()", slug).attributes,
      "prompt.slug": slug,
      "prompt.version": version,
    },
  });
}

/** Create an override — a dashboard/API edit that takes priority over the deployed version. */
export async function createPromptOverride(
  slug: string,
  body: CreatePromptOverrideRequestBody,
  requestOptions?: ApiRequestOptions
): Promise<PromptOverrideCreatedResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.createPromptOverride(slug, body, {
    ...promptSpanOptions("prompts.createOverride()", slug),
    attributes: {
      ...promptSpanOptions("prompts.createOverride()", slug).attributes,
      "prompt.slug": slug,
      ...(body.model ? { "prompt.model": body.model } : {}),
    },
    onResponseBody: (body, span) => {
      span.setAttribute("prompt.override.version", body.version);
    },
  });
}

/** Update the active override's content or model. */
export async function updatePromptOverride(
  slug: string,
  body: UpdatePromptOverrideRequestBody,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.updatePromptOverride(slug, body, {
    ...promptSpanOptions("prompts.updateOverride()", slug),
    attributes: {
      ...promptSpanOptions("prompts.updateOverride()", slug).attributes,
      "prompt.slug": slug,
    },
  });
}

/** Remove the active override, reverting to the current deployed version. */
export async function removePromptOverride(
  slug: string,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.removePromptOverride(slug, {
    ...promptSpanOptions("prompts.removeOverride()", slug),
    attributes: {
      ...promptSpanOptions("prompts.removeOverride()", slug).attributes,
      "prompt.slug": slug,
    },
  });
}

/** Reactivate a previously removed override version. */
export async function reactivatePromptOverride(
  slug: string,
  version: number,
  requestOptions?: ApiRequestOptions
): Promise<PromptOkResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();
  return apiClient.reactivatePromptOverride(slug, { version }, {
    ...promptSpanOptions("prompts.reactivateOverride()", slug),
    attributes: {
      ...promptSpanOptions("prompts.reactivateOverride()", slug).attributes,
      "prompt.slug": slug,
      "prompt.version": version,
    },
  });
}
