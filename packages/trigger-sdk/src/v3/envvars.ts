import type {
  ImportEnvironmentVariablesParams,
  EnvironmentVariableResponseBody,
} from "@trigger.dev/core/v3";
import { SemanticInternalAttributes, apiClientManager, taskContext } from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";
import { tracer } from "./tracer";

export type { ImportEnvironmentVariablesParams };

export async function upload(
  projectRef: string,
  slug: string,
  params: ImportEnvironmentVariablesParams
): Promise<EnvironmentVariableResponseBody>;
export async function upload(
  params: ImportEnvironmentVariablesParams
): Promise<EnvironmentVariableResponseBody>;
export async function upload(
  projectRefOrParams: string | ImportEnvironmentVariablesParams,
  slug?: string,
  params?: ImportEnvironmentVariablesParams
): Promise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $params: ImportEnvironmentVariablesParams;
  let $slug: string;

  if (taskContext.ctx) {
    if (typeof projectRefOrParams === "string") {
      $projectRef = projectRefOrParams;
      $slug = slug ?? taskContext.ctx.environment.slug;

      if (!params) {
        throw new Error("params is required");
      }

      $params = params;
    } else {
      $params = projectRefOrParams;
      $projectRef = taskContext.ctx.project.ref;
      $slug = taskContext.ctx.environment.slug;
    }
  } else {
    if (typeof projectRefOrParams !== "string") {
      throw new Error("projectRef is required");
    }

    if (!slug) {
      throw new Error("slug is required");
    }

    if (!params) {
      throw new Error("params is required");
    }

    $projectRef = projectRefOrParams;
    $slug = slug;
    $params = params;
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await tracer.startActiveSpan(
    "envvars.upload",
    async (span) => {
      return await apiClient.importEnvVars($projectRef, $slug, $params);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "file-upload",
      },
    }
  );
}
