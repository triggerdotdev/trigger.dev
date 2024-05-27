import type {
  ApiPromise,
  CreateEnvironmentVariableParams,
  EnvironmentVariableResponseBody,
  EnvironmentVariableValue,
  EnvironmentVariables,
  ImportEnvironmentVariablesParams,
  UpdateEnvironmentVariableParams,
} from "@trigger.dev/core/v3";
import { apiClientManager, taskContext } from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";

export type { CreateEnvironmentVariableParams, ImportEnvironmentVariablesParams };

export function upload(
  projectRef: string,
  slug: string,
  params: ImportEnvironmentVariablesParams
): ApiPromise<EnvironmentVariableResponseBody>;
export function upload(
  params: ImportEnvironmentVariablesParams
): ApiPromise<EnvironmentVariableResponseBody>;
export function upload(
  projectRefOrParams: string | ImportEnvironmentVariablesParams,
  slug?: string,
  params?: ImportEnvironmentVariablesParams
): ApiPromise<EnvironmentVariableResponseBody> {
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

  return apiClient.importEnvVars($projectRef, $slug, $params);
}

export function list(projectRef: string, slug: string): ApiPromise<EnvironmentVariables>;
export function list(): ApiPromise<EnvironmentVariables>;
export function list(projectRef?: string, slug?: string): ApiPromise<EnvironmentVariables> {
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

  return apiClient.listEnvVars($projectRef, $slug);
}

export function create(
  projectRef: string,
  slug: string,
  params: CreateEnvironmentVariableParams
): ApiPromise<EnvironmentVariableResponseBody>;
export function create(
  params: CreateEnvironmentVariableParams
): ApiPromise<EnvironmentVariableResponseBody>;
export function create(
  projectRefOrParams: string | CreateEnvironmentVariableParams,
  slug?: string,
  params?: CreateEnvironmentVariableParams
): ApiPromise<EnvironmentVariableResponseBody> {
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

  return apiClient.createEnvVar($projectRef, $slug, $params);
}

export function retrieve(
  projectRef: string,
  slug: string,
  name: string
): ApiPromise<EnvironmentVariableValue>;
export function retrieve(name: string): ApiPromise<EnvironmentVariableValue>;
export function retrieve(
  projectRefOrName: string,
  slug?: string,
  name?: string
): ApiPromise<EnvironmentVariableValue> {
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

  return apiClient.retrieveEnvVar($projectRef, $slug, $name);
}

export function del(
  projectRef: string,
  slug: string,
  name: string
): ApiPromise<EnvironmentVariableResponseBody>;
export function del(name: string): ApiPromise<EnvironmentVariableResponseBody>;
export function del(
  projectRefOrName: string,
  slug?: string,
  name?: string
): ApiPromise<EnvironmentVariableResponseBody> {
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

  return apiClient.deleteEnvVar($projectRef, $slug, $name);
}

export function update(
  projectRef: string,
  slug: string,
  name: string,
  params: UpdateEnvironmentVariableParams
): ApiPromise<EnvironmentVariableResponseBody>;
export function update(
  name: string,
  params: UpdateEnvironmentVariableParams
): ApiPromise<EnvironmentVariableResponseBody>;
export function update(
  projectRefOrName: string,
  slugOrParams: string | UpdateEnvironmentVariableParams,
  name?: string,
  params?: UpdateEnvironmentVariableParams
): ApiPromise<EnvironmentVariableResponseBody> {
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

  return apiClient.updateEnvVar($projectRef, $slug, $name, $params);
}
