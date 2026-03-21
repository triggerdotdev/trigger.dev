import {
  accessoryAttributes,
  apiClientManager,
  resourceCatalog,
  SemanticInternalAttributes,
  taskContext,
  type PromptMetadataWithFunctions,
  type TaskSchema,
  type inferSchemaIn,
  getSchemaParseFn,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

type PromptOptions<TVariables extends TaskSchema | undefined = undefined> = {
  id: string;
  description?: string;
  model?: string;
  config?: Record<string, unknown>;
  variables?: TVariables;
  content: string;
};

type ResolvedPrompt = {
  promptId: string;
  version: number;
  labels: string[];
  text: string;
  model: string | undefined;
  config: Record<string, unknown> | undefined;
  /** Returns `experimental_telemetry` options for AI SDK calls (`generateText`, `streamText`, etc.) */
  toAISDKTelemetry(additionalMetadata?: Record<string, string>): {
    experimental_telemetry: {
      isEnabled: true;
      metadata: Record<string, string>;
    };
  };
};

export type { PromptOptions, ResolvedPrompt };

export type PromptHandle<TVariables extends TaskSchema | undefined = undefined> = {
  id: string;
  resolve(
    variables: inferSchemaIn<TVariables>,
    options?: { label?: string; version?: number }
  ): Promise<ResolvedPrompt>;
};

/**
 * Compile a Mustache-style template by substituting `{{variable}}` placeholders.
 */
function compileTemplate(
  template: string,
  variables: Record<string, unknown>
): string {
  // Handle conditional sections: {{#key}}...{{/key}}
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key, content) => {
      const value = variables[key];
      return value
        ? content.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => {
            return String(variables[k] ?? "");
          })
        : "";
    }
  );

  // Handle simple substitutions: {{key}}
  result = result.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : "";
  });

  return result;
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

function resolveLocally(
  options: PromptOptions<any>,
  variables: Record<string, unknown>
): ResolvedPrompt {
  const inputJson = Object.keys(variables).length > 0 ? JSON.stringify(variables) : undefined;
  const telemetryFn = makeToAISDKTelemetry(options.id, options.id, 0, ["local"], options.model, inputJson);

  return {
    promptId: options.id,
    version: 0,
    labels: ["local"],
    text: compileTemplate(options.content, variables),
    model: options.model,
    config: options.config,
    toAISDKTelemetry: telemetryFn,
  };
}

export function definePrompt<TVariables extends TaskSchema | undefined = undefined>(
  options: PromptOptions<TVariables>
): PromptHandle<TVariables> {
  const parseVariables = options.variables
    ? getSchemaParseFn(options.variables)
    : undefined;

  // Register with resource catalog
  const metadata: PromptMetadataWithFunctions = {
    id: options.id,
    description: options.description,
    content: options.content,
    model: options.model,
    config: options.config,
    variableSchema: undefined, // Set by CLI via schemaToJsonSchema
    schema: options.variables,
    fns: {
      resolve: async (variables: Record<string, unknown>) => {
        const validated = parseVariables ? await parseVariables(variables) : variables;
        return resolveLocally(options, validated as Record<string, unknown>);
      },
    },
  };

  resourceCatalog.registerPromptMetadata(metadata);

  return {
    id: options.id,
    resolve: async (variables, resolveOptions) => {
      // Validate variables if schema provided
      const validated = parseVariables
        ? await parseVariables(variables)
        : variables;
      const vars = validated as Record<string, unknown>;

      const ctx = taskContext.ctx;
      const apiClient = apiClientManager.client;

      // If we're running inside a task on the platform, resolve via the API
      if (ctx && apiClient) {
        const response = await apiClient.resolvePrompt(
          options.id,
          {
            variables: vars,
            label: resolveOptions?.label,
            version: resolveOptions?.version,
          },
          {
            tracer,
            name: "prompt.resolve()",
            icon: "tabler-file-text-ai",
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "tabler-file-text-ai",
              [SemanticInternalAttributes.ENTITY_TYPE]: "prompt",
              [SemanticInternalAttributes.ENTITY_ID]: options.id,
              ...accessoryAttributes({
                items: [
                  {
                    text: options.id,
                    variant: "normal",
                  },
                ],
                style: "codepath",
              }),
            },
            onResponseBody: (body, span) => {
              span.setAttribute("prompt.version", body.data.version);
              span.setAttribute("prompt.slug", body.data.slug);
              span.setAttribute("prompt.labels", body.data.labels.join(", "));
              if (body.data.model) {
                span.setAttribute("prompt.model", body.data.model);
              }
              if (body.data.template) {
                span.setAttribute("prompt.template", body.data.template);
              }
              if (body.data.text) {
                span.setAttribute("prompt.text", body.data.text);
              }
              if (body.data.config) {
                span.setAttribute("prompt.config", JSON.stringify(body.data.config));
              }
              if (vars && Object.keys(vars).length > 0) {
                span.setAttribute("prompt.input", JSON.stringify(vars));
              }
            },
          }
        );

        const data = response.data;
        const inputJson = vars && Object.keys(vars).length > 0 ? JSON.stringify(vars) : undefined;
        const telemetryFn = makeToAISDKTelemetry(
          data.slug,
          data.promptId,
          data.version,
          data.labels,
          data.model ?? undefined,
          inputJson
        );

        return {
          promptId: data.promptId,
          version: data.version,
          labels: data.labels,
          text: data.text ?? "",
          model: data.model ?? undefined,
          config: (data.config as Record<string, unknown>) ?? undefined,
          toAISDKTelemetry: telemetryFn,
        };
      }

      // Fallback: resolve locally (outside platform or during dev)
      return resolveLocally(options, vars);
    },
  };
}
