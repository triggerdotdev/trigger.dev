import type {
  ImportEnvironmentVariablesParams,
  EnvironmentVariableResponseBody,
  EnvironmentVariables,
  CreateEnvironmentVariableParams,
  EnvironmentVariableValue,
  UpdateEnvironmentVariableParams,
} from "@trigger.dev/core/v3";
import { SemanticInternalAttributes, apiClientManager, taskContext } from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";
import { tracer } from "./tracer";

export type { ImportEnvironmentVariablesParams, CreateEnvironmentVariableParams };

export async function upload(
  projectRef: string,
  slug: string,
  params: ImportEnvironmentVariablesParams
): ApiPromise<EnvironmentVariableResponseBody>;
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

export async function list(projectRef: string, slug: string): Promise<EnvironmentVariables>;
export async function list(): Promise<EnvironmentVariables>;
export async function list(projectRef?: string, slug?: string): Promise<EnvironmentVariables> {
  const $projectRef = projectRef ?? taskContext.ctx?.project.ref;
  const $slug = slug ?? taskContext.ctx?.environment.slug;

  if (!$projectRef) {
    throw new Error("projectRef is required");
  }

  if (!$slug) {
    throw new Error("slug is required");
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await tracer.startActiveSpan(
    "envvars.list",
    async (span) => {
      return await apiClient.listEnvVars($projectRef, $slug);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "id",
      },
    }
  );
}

export async function create(
  projectRef: string,
  slug: string,
  params: CreateEnvironmentVariableParams
): Promise<EnvironmentVariableResponseBody>;
export async function create(
  params: CreateEnvironmentVariableParams
): Promise<EnvironmentVariableResponseBody>;
export async function create(
  projectRefOrParams: string | CreateEnvironmentVariableParams,
  slug?: string,
  params?: CreateEnvironmentVariableParams
): Promise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $slug: string;
  let $params: CreateEnvironmentVariableParams;

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
    "envvars.create",
    async (span) => {
      return await apiClient.createEnvVar($projectRef, $slug, $params);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "id",
      },
    }
  );
}

export async function retrieve(
  projectRef: string,
  slug: string,
  name: string
): Promise<EnvironmentVariableValue>;
export async function retrieve(name: string): Promise<EnvironmentVariableValue>;
export async function retrieve(
  projectRefOrName: string,
  slug?: string,
  name?: string
): Promise<EnvironmentVariableValue> {
  let $projectRef: string;
  let $slug: string;
  let $name: string;

  if (typeof name === "string") {
    $projectRef = projectRefOrName;
    $slug = slug!;
    $name = name;
  } else {
    $projectRef = taskContext.ctx?.project.ref!;
    $slug = taskContext.ctx?.environment.slug!;
    $name = projectRefOrName;
  }

  if (!$projectRef) {
    throw new Error("projectRef is required");
  }

  if (!$slug) {
    throw new Error("slug is required");
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await tracer.startActiveSpan(
    "envvars.retrieve",
    async (span) => {
      return await apiClient.retrieveEnvVar($projectRef, $slug, $name);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "id",
      },
    }
  );
}

export async function del(
  projectRef: string,
  slug: string,
  name: string
): Promise<EnvironmentVariableResponseBody>;
export async function del(name: string): Promise<EnvironmentVariableResponseBody>;
export async function del(
  projectRefOrName: string,
  slug?: string,
  name?: string
): Promise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $slug: string;
  let $name: string;

  if (typeof name === "string") {
    $projectRef = projectRefOrName;
    $slug = slug!;
    $name = name;
  } else {
    $projectRef = taskContext.ctx?.project.ref!;
    $slug = taskContext.ctx?.environment.slug!;
    $name = projectRefOrName;
  }

  if (!$projectRef) {
    throw new Error("projectRef is required");
  }

  if (!$slug) {
    throw new Error("slug is required");
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await tracer.startActiveSpan(
    "envvars.delete",
    async (span) => {
      return await apiClient.deleteEnvVar($projectRef, $slug, $name);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "id",
      },
    }
  );
}

export async function update(
  projectRef: string,
  slug: string,
  name: string,
  params: UpdateEnvironmentVariableParams
): Promise<EnvironmentVariableResponseBody>;
export async function update(
  name: string,
  params: UpdateEnvironmentVariableParams
): Promise<EnvironmentVariableResponseBody>;
export async function update(
  projectRefOrName: string,
  slugOrParams: string | UpdateEnvironmentVariableParams,
  name?: string,
  params?: UpdateEnvironmentVariableParams
): Promise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $slug: string;
  let $name: string;
  let $params: UpdateEnvironmentVariableParams;

  if (taskContext.ctx) {
    if (typeof slugOrParams === "string") {
      $projectRef = slugOrParams;
      $slug = slugOrParams ?? taskContext.ctx.environment.slug;
      $name = name!;

      if (!params) {
        throw new Error("params is required");
      }

      $params = params;
    } else {
      $params = slugOrParams;
      $projectRef = taskContext.ctx.project.ref;
      $slug = taskContext.ctx.environment.slug;
      $name = projectRefOrName;
    }
  } else {
    if (typeof slugOrParams !== "string") {
      throw new Error("slug is required");
    }

    if (!projectRefOrName) {
      throw new Error("projectRef is required");
    }

    if (!params) {
      throw new Error("params is required");
    }

    $projectRef = projectRefOrName;
    $slug = slugOrParams;
    $name = name!;
    $params = params;
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await tracer.startActiveSpan(
    "envvars.update",
    async (span) => {
      return await apiClient.updateEnvVar($projectRef, $slug, $name, $params);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "id",
      },
    }
  );
}
