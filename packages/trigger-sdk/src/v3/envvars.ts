import type {
  ApiPromise,
  ApiRequestOptions,
  CreateEnvironmentVariableParams,
  EnvironmentVariableResponseBody,
  EnvironmentVariableValue,
  EnvironmentVariableWithSecret,
  EnvironmentVariables,
  ImportEnvironmentVariablesParams,
  UpdateEnvironmentVariableParams,
} from "@trigger.dev/core/v3";
import {
  apiClientManager,
  isRequestOptions,
  mergeRequestOptions,
  taskContext,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type { CreateEnvironmentVariableParams, ImportEnvironmentVariablesParams };

export function upload(
  projectRef: string,
  slug: string,
  params: ImportEnvironmentVariablesParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function upload(
  params: ImportEnvironmentVariablesParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function upload(
  projectRefOrParams: string | ImportEnvironmentVariablesParams,
  slugOrRequestOptions?: string | ApiRequestOptions,
  params?: ImportEnvironmentVariablesParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $params: ImportEnvironmentVariablesParams;
  let $slug: string;
  const $requestOptions = overloadRequestOptions("upload", slugOrRequestOptions, requestOptions);

  if (taskContext.ctx) {
    if (typeof projectRefOrParams === "string") {
      $projectRef = projectRefOrParams;
      $slug =
        typeof slugOrRequestOptions === "string"
          ? slugOrRequestOptions
          : taskContext.ctx.environment.slug;

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

    if (!slugOrRequestOptions || typeof slugOrRequestOptions !== "string") {
      throw new Error("slug is required");
    }

    if (!params) {
      throw new Error("params is required");
    }

    $projectRef = projectRefOrParams;
    $slug = slugOrRequestOptions;
    $params = params;
  }

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.importEnvVars($projectRef, $slug, $params, $requestOptions);
}

export function list(
  projectRef: string,
  slug: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableWithSecret[]>;
export function list(
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableWithSecret[]>;
export function list(
  projectRefOrRequestOptions?: string | ApiRequestOptions,
  slug?: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableWithSecret[]> {
  const $projectRef = !isRequestOptions(projectRefOrRequestOptions)
    ? projectRefOrRequestOptions
    : taskContext.ctx?.project.ref;
  const $slug = slug ?? taskContext.ctx?.environment.slug;
  let $requestOptions = isRequestOptions(projectRefOrRequestOptions)
    ? projectRefOrRequestOptions
    : requestOptions;

  if (!$projectRef) {
    throw new Error("projectRef is required");
  }

  if (!$slug) {
    throw new Error("slug is required");
  }

  $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "envvars.list()",
      icon: "id-badge",
    },
    $requestOptions
  );

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.listEnvVars($projectRef, $slug, $requestOptions);
}

export function create(
  projectRef: string,
  slug: string,
  params: CreateEnvironmentVariableParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function create(
  params: CreateEnvironmentVariableParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function create(
  projectRefOrParams: string | CreateEnvironmentVariableParams,
  slugOrRequestOptions?: string | ApiRequestOptions,
  params?: CreateEnvironmentVariableParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $slug: string;
  let $params: CreateEnvironmentVariableParams;
  const $requestOptions = overloadRequestOptions("create", slugOrRequestOptions, requestOptions);

  if (taskContext.ctx) {
    if (typeof projectRefOrParams === "string") {
      $projectRef = projectRefOrParams;
      $slug =
        typeof slugOrRequestOptions === "string"
          ? slugOrRequestOptions
          : taskContext.ctx.environment.slug;

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

    if (!slugOrRequestOptions || typeof slugOrRequestOptions !== "string") {
      throw new Error("slug is required");
    }

    if (!params) {
      throw new Error("params is required");
    }

    $projectRef = projectRefOrParams;
    $slug = slugOrRequestOptions;
    $params = params;
  }

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.createEnvVar($projectRef, $slug, $params, $requestOptions);
}

export function retrieve(
  projectRef: string,
  slug: string,
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableWithSecret>;
export function retrieve(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableWithSecret>;
export function retrieve(
  projectRefOrName: string,
  slugOrRequestOptions?: string | ApiRequestOptions,
  name?: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableWithSecret> {
  let $projectRef: string;
  let $slug: string;
  let $name: string;
  const $requestOptions = overloadRequestOptions("retrieve", slugOrRequestOptions, requestOptions);

  if (typeof name === "string") {
    $projectRef = projectRefOrName;
    $slug =
      typeof slugOrRequestOptions === "string"
        ? slugOrRequestOptions
        : taskContext.ctx?.environment.slug!;
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

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.retrieveEnvVar($projectRef, $slug, $name, $requestOptions);
}

export function del(
  projectRef: string,
  slug: string,
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function del(
  name: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function del(
  projectRefOrName: string,
  slugOrRequestOptions?: string | ApiRequestOptions,
  name?: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $slug: string;
  let $name: string;
  const $requestOptions = overloadRequestOptions("del", slugOrRequestOptions, requestOptions);

  if (typeof name === "string") {
    $projectRef = projectRefOrName;
    $slug =
      typeof slugOrRequestOptions === "string"
        ? slugOrRequestOptions
        : taskContext.ctx?.environment.slug!;
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

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.deleteEnvVar($projectRef, $slug, $name, $requestOptions);
}

export function update(
  projectRef: string,
  slug: string,
  name: string,
  params: UpdateEnvironmentVariableParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function update(
  name: string,
  params: UpdateEnvironmentVariableParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody>;
export function update(
  projectRefOrName: string,
  slugOrParams: string | UpdateEnvironmentVariableParams,
  nameOrRequestOptions?: string | ApiRequestOptions,
  params?: UpdateEnvironmentVariableParams,
  requestOptions?: ApiRequestOptions
): ApiPromise<EnvironmentVariableResponseBody> {
  let $projectRef: string;
  let $slug: string;
  let $name: string;
  let $params: UpdateEnvironmentVariableParams;
  const $requestOptions = overloadRequestOptions("update", nameOrRequestOptions, requestOptions);

  if (taskContext.ctx) {
    if (typeof slugOrParams === "string") {
      $projectRef = slugOrParams;
      $slug = slugOrParams ?? taskContext.ctx.environment.slug;
      $name =
        typeof nameOrRequestOptions === "string"
          ? nameOrRequestOptions
          : taskContext.ctx.environment.slug;

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

  const apiClient = apiClientManager.clientOrThrow();

  return apiClient.updateEnvVar($projectRef, $slug, $name, $params, $requestOptions);
}

function overloadRequestOptions(
  name: string,
  slugOrRequestOptions?: string | ApiRequestOptions,
  requestOptions?: ApiRequestOptions
): ApiRequestOptions {
  if (isRequestOptions(slugOrRequestOptions)) {
    return mergeRequestOptions(
      {
        tracer,
        name: `envvars.${name}()`,
        icon: "id-badge",
      },
      slugOrRequestOptions
    );
  } else {
    return mergeRequestOptions(
      {
        tracer,
        name: `envvars.${name}()`,
        icon: "id-badge",
      },
      requestOptions
    );
  }
}
