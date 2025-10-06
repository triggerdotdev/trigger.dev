import { z } from "zod";
import {
  ApiAuthenticationResultSuccess,
  authenticateApiRequestWithFailure,
} from "../apiAuth.server";
import { ActionFunctionArgs, json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { fromZodError } from "zod-validation-error";
import { apiCors } from "~/utils/apiCors";
import {
  AuthorizationAction,
  AuthorizationResources,
  checkAuthorization,
} from "../authorization.server";
import { logger } from "../logger.server";
import {
  authenticateApiRequestWithPersonalAccessToken,
  PersonalAccessTokenAuthenticationResult,
} from "../personalAccessToken.server";
import { safeJsonParse } from "~/utils/json";
import {
  AuthenticatedWorkerInstance,
  WorkerGroupTokenService,
} from "~/v3/services/worker/workerGroupTokenService.server";
import { API_VERSIONS, getApiVersion } from "~/api/versions";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/runEngineWorker";
import { ServiceValidationError } from "~/v3/services/common.server";
import { EngineServiceValidationError } from "@internal/run-engine";

type AnyZodSchema = z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;

type ApiKeyRouteBuilderOptions<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TResource = never
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  allowJWT?: boolean;
  corsStrategy?: "all" | "none";
  findResource: (
    params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
      ? z.infer<TParamsSchema>
      : undefined,
    authentication: ApiAuthenticationResultSuccess,
    searchParams: TSearchParamsSchema extends
      | z.ZodFirstPartySchemaTypes
      | z.ZodDiscriminatedUnion<any, any>
      ? z.infer<TSearchParamsSchema>
      : undefined
  ) => Promise<TResource | undefined>;
  shouldRetryNotFound?: boolean;
  authorization?: {
    action: AuthorizationAction;
    resource: (
      resource: NonNullable<TResource>,
      params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<TParamsSchema>
        : undefined,
      searchParams: TSearchParamsSchema extends
        | z.ZodFirstPartySchemaTypes
        | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<TSearchParamsSchema>
        : undefined,
      headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<THeadersSchema>
        : undefined
    ) => AuthorizationResources;
    superScopes?: string[];
  };
};

type ApiKeyHandlerFunction<
  TParamsSchema extends AnyZodSchema | undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TResource = never
> = (args: {
  params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TParamsSchema>
    : undefined;
  searchParams: TSearchParamsSchema extends
    | z.ZodFirstPartySchemaTypes
    | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TSearchParamsSchema>
    : undefined;
  headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<THeadersSchema>
    : undefined;
  authentication: ApiAuthenticationResultSuccess;
  request: Request;
  resource: NonNullable<TResource>;
  apiVersion: API_VERSIONS;
}) => Promise<Response>;

export function createLoaderApiRoute<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TResource = never
>(
  options: ApiKeyRouteBuilderOptions<TParamsSchema, TSearchParamsSchema, THeadersSchema, TResource>,
  handler: ApiKeyHandlerFunction<TParamsSchema, TSearchParamsSchema, THeadersSchema, TResource>
) {
  return async function loader({ request, params }: LoaderFunctionArgs) {
    const {
      params: paramsSchema,
      searchParams: searchParamsSchema,
      headers: headersSchema,
      allowJWT = false,
      corsStrategy = "none",
      authorization,
      findResource,
      shouldRetryNotFound,
    } = options;

    if (corsStrategy !== "none" && request.method.toUpperCase() === "OPTIONS") {
      return apiCors(request, json({}));
    }

    try {
      const authenticationResult = await authenticateApiRequestWithFailure(request, { allowJWT });

      if (!authenticationResult) {
        return await wrapResponse(
          request,
          json({ error: "Invalid or Missing API key" }, { status: 401 }),
          corsStrategy !== "none"
        );
      }

      if (!authenticationResult.ok) {
        return await wrapResponse(
          request,
          json({ error: authenticationResult.error }, { status: 401 }),
          corsStrategy !== "none"
        );
      }

      let parsedParams: any = undefined;
      if (paramsSchema) {
        const parsed = paramsSchema.safeParse(params);
        if (!parsed.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Params Error", details: fromZodError(parsed.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedParams = parsed.data;
      }

      let parsedSearchParams: any = undefined;
      if (searchParamsSchema) {
        const searchParams = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = searchParamsSchema.safeParse(searchParams);
        if (!parsed.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Query Error", details: fromZodError(parsed.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedSearchParams = parsed.data;
      }

      let parsedHeaders: any = undefined;
      if (headersSchema) {
        const rawHeaders = Object.fromEntries(request.headers);
        const headers = headersSchema.safeParse(rawHeaders);
        if (!headers.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Headers Error", details: fromZodError(headers.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedHeaders = headers.data;
      }

      // Find the resource
      const resource = await findResource(parsedParams, authenticationResult, parsedSearchParams);

      if (!resource) {
        return await wrapResponse(
          request,
          json(
            { error: "Not found" },
            { status: 404, headers: { "x-should-retry": shouldRetryNotFound ? "true" : "false" } }
          ),
          corsStrategy !== "none"
        );
      }

      if (authorization) {
        const { action, resource: authResource, superScopes } = authorization;
        const $authResource = authResource(
          resource,
          parsedParams,
          parsedSearchParams,
          parsedHeaders
        );

        logger.debug("Checking authorization", {
          action,
          resource: $authResource,
          superScopes,
          scopes: authenticationResult.scopes,
        });

        const authorizationResult = checkAuthorization(
          authenticationResult,
          action,
          $authResource,
          superScopes
        );

        if (!authorizationResult.authorized) {
          return await wrapResponse(
            request,
            json(
              {
                error: `Unauthorized: ${authorizationResult.reason}`,
                code: "unauthorized",
                param: "access_token",
                type: "authorization",
              },
              { status: 403 }
            ),
            corsStrategy !== "none"
          );
        }
      }

      const apiVersion = getApiVersion(request);

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
        authentication: authenticationResult,
        request,
        resource,
        apiVersion,
      });
      return await wrapResponse(request, result, corsStrategy !== "none");
    } catch (error) {
      try {
        if (error instanceof Response) {
          return await wrapResponse(request, error, corsStrategy !== "none");
        }

        logger.error("Error in loader", {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
          url: request.url,
        });

        return await wrapResponse(
          request,
          json({ error: "Internal Server Error" }, { status: 500 }),
          corsStrategy !== "none"
        );
      } catch (innerError) {
        logger.error("[apiBuilder] Failed to handle error", { error, innerError });

        return json({ error: "Internal Server Error" }, { status: 500 });
      }
    }
  };
}

type PATRouteBuilderOptions<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  corsStrategy?: "all" | "none";
};

type PATHandlerFunction<
  TParamsSchema extends AnyZodSchema | undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
> = (args: {
  params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TParamsSchema>
    : undefined;
  searchParams: TSearchParamsSchema extends
    | z.ZodFirstPartySchemaTypes
    | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TSearchParamsSchema>
    : undefined;
  headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<THeadersSchema>
    : undefined;
  authentication: PersonalAccessTokenAuthenticationResult;
  request: Request;
  apiVersion: API_VERSIONS;
}) => Promise<Response>;

export function createLoaderPATApiRoute<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
>(
  options: PATRouteBuilderOptions<TParamsSchema, TSearchParamsSchema, THeadersSchema>,
  handler: PATHandlerFunction<TParamsSchema, TSearchParamsSchema, THeadersSchema>
) {
  return async function loader({ request, params }: LoaderFunctionArgs) {
    const {
      params: paramsSchema,
      searchParams: searchParamsSchema,
      headers: headersSchema,
      corsStrategy = "none",
    } = options;

    if (corsStrategy !== "none" && request.method.toUpperCase() === "OPTIONS") {
      return apiCors(request, json({}));
    }

    try {
      const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

      if (!authenticationResult) {
        return await wrapResponse(
          request,
          json({ error: "Invalid or Missing API key" }, { status: 401 }),
          corsStrategy !== "none"
        );
      }

      let parsedParams: any = undefined;
      if (paramsSchema) {
        const parsed = paramsSchema.safeParse(params);
        if (!parsed.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Params Error", details: fromZodError(parsed.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedParams = parsed.data;
      }

      let parsedSearchParams: any = undefined;
      if (searchParamsSchema) {
        const searchParams = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = searchParamsSchema.safeParse(searchParams);
        if (!parsed.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Query Error", details: fromZodError(parsed.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedSearchParams = parsed.data;
      }

      let parsedHeaders: any = undefined;
      if (headersSchema) {
        const rawHeaders = Object.fromEntries(request.headers);
        const headers = headersSchema.safeParse(rawHeaders);
        if (!headers.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Headers Error", details: fromZodError(headers.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedHeaders = headers.data;
      }

      const apiVersion = getApiVersion(request);

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
        authentication: authenticationResult,
        request,
        apiVersion,
      });
      return await wrapResponse(request, result, corsStrategy !== "none");
    } catch (error) {
      try {
        if (error instanceof Response) {
          return await wrapResponse(request, error, corsStrategy !== "none");
        }
        return await wrapResponse(
          request,
          json({ error: "Internal Server Error" }, { status: 500 }),
          corsStrategy !== "none"
        );
      } catch (innerError) {
        logger.error("[apiBuilder] Failed to handle error", { error, innerError });

        return json({ error: "Internal Server Error" }, { status: 500 });
      }
    }
  };
}

type ApiKeyActionRouteBuilderOptions<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TBodySchema extends AnyZodSchema | undefined = undefined,
  TResource = never
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  allowJWT?: boolean;
  corsStrategy?: "all" | "none";
  method?: "POST" | "PUT" | "DELETE" | "PATCH";
  findResource?: (
    params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
      ? z.infer<TParamsSchema>
      : undefined,
    authentication: ApiAuthenticationResultSuccess,
    searchParams: TSearchParamsSchema extends
      | z.ZodFirstPartySchemaTypes
      | z.ZodDiscriminatedUnion<any, any>
      ? z.infer<TSearchParamsSchema>
      : undefined
  ) => Promise<TResource | undefined>;
  authorization?: {
    action: AuthorizationAction;
    resource: (
      params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<TParamsSchema>
        : undefined,
      searchParams: TSearchParamsSchema extends
        | z.ZodFirstPartySchemaTypes
        | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<TSearchParamsSchema>
        : undefined,
      headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<THeadersSchema>
        : undefined,
      body: TBodySchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
        ? z.infer<TBodySchema>
        : undefined
    ) => AuthorizationResources;
    superScopes?: string[];
  };
  maxContentLength?: number;
  body?: TBodySchema;
};

type ApiKeyActionHandlerFunction<
  TParamsSchema extends AnyZodSchema | undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TBodySchema extends AnyZodSchema | undefined = undefined,
  TResource = never
> = (args: {
  params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TParamsSchema>
    : undefined;
  searchParams: TSearchParamsSchema extends
    | z.ZodFirstPartySchemaTypes
    | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TSearchParamsSchema>
    : undefined;
  headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<THeadersSchema>
    : undefined;
  body: TBodySchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TBodySchema>
    : undefined;
  authentication: ApiAuthenticationResultSuccess;
  request: Request;
  resource?: TResource;
}) => Promise<Response>;

export function createActionApiRoute<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TBodySchema extends AnyZodSchema | undefined = undefined,
  TResource = never
>(
  options: ApiKeyActionRouteBuilderOptions<
    TParamsSchema,
    TSearchParamsSchema,
    THeadersSchema,
    TBodySchema,
    TResource
  >,
  handler: ApiKeyActionHandlerFunction<
    TParamsSchema,
    TSearchParamsSchema,
    THeadersSchema,
    TBodySchema,
    TResource
  >
) {
  const {
    params: paramsSchema,
    searchParams: searchParamsSchema,
    headers: headersSchema,
    body: bodySchema,
    allowJWT = false,
    corsStrategy = "none",
    authorization,
    maxContentLength,
  } = options;

  async function loader({ request, params }: LoaderFunctionArgs) {
    if (corsStrategy !== "none" && request.method.toUpperCase() === "OPTIONS") {
      return apiCors(request, json({}));
    }

    return new Response(null, { status: 405 });
  }

  async function action({ request, params }: ActionFunctionArgs) {
    if (options.method) {
      if (request.method.toUpperCase() !== options.method) {
        return await wrapResponse(
          request,
          json(
            { error: "Method not allowed" },
            { status: 405, headers: { Allow: options.method } }
          ),
          corsStrategy !== "none"
        );
      }
    }

    try {
      const authenticationResult = await authenticateApiRequestWithFailure(request, { allowJWT });

      if (!authenticationResult) {
        return await wrapResponse(
          request,
          json({ error: "Invalid or Missing API key" }, { status: 401 }),
          corsStrategy !== "none"
        );
      }

      if (!authenticationResult.ok) {
        return await wrapResponse(
          request,
          json({ error: authenticationResult.error }, { status: 401 }),
          corsStrategy !== "none"
        );
      }

      if (maxContentLength) {
        const contentLength = request.headers.get("content-length");

        if (!contentLength || parseInt(contentLength) > maxContentLength) {
          return json({ error: "Request body too large" }, { status: 413 });
        }
      }

      let parsedParams: any = undefined;
      if (paramsSchema) {
        const parsed = paramsSchema.safeParse(params);
        if (!parsed.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Params Error", details: fromZodError(parsed.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedParams = parsed.data;
      }

      let parsedSearchParams: any = undefined;
      if (searchParamsSchema) {
        const searchParams = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = searchParamsSchema.safeParse(searchParams);
        if (!parsed.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Query Error", details: fromZodError(parsed.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedSearchParams = parsed.data;
      }

      let parsedHeaders: any = undefined;
      if (headersSchema) {
        const rawHeaders = Object.fromEntries(request.headers);
        const headers = headersSchema.safeParse(rawHeaders);
        if (!headers.success) {
          return await wrapResponse(
            request,
            json(
              { error: "Headers Error", details: fromZodError(headers.error).details },
              { status: 400 }
            ),
            corsStrategy !== "none"
          );
        }
        parsedHeaders = headers.data;
      }

      let parsedBody: any = undefined;
      if (bodySchema) {
        const rawBody = await request.text();
        if (rawBody.length === 0) {
          return await wrapResponse(
            request,
            json({ error: "Request body is empty" }, { status: 400 }),
            corsStrategy !== "none"
          );
        }

        const rawParsedJson = safeJsonParse(rawBody);

        if (!rawParsedJson) {
          return await wrapResponse(
            request,
            json({ error: "Invalid JSON" }, { status: 400 }),
            corsStrategy !== "none"
          );
        }

        const body = bodySchema.safeParse(rawParsedJson);
        if (!body.success) {
          return await wrapResponse(
            request,
            json({ error: fromZodError(body.error).toString() }, { status: 400 }),
            corsStrategy !== "none"
          );
        }
        parsedBody = body.data;
      }

      if (authorization) {
        const { action, resource, superScopes } = authorization;
        const $resource = resource(parsedParams, parsedSearchParams, parsedHeaders, parsedBody);

        logger.debug("Checking authorization", {
          action,
          resource: $resource,
          superScopes,
          scopes: authenticationResult.scopes,
        });

        const authorizationResult = checkAuthorization(
          authenticationResult,
          action,
          $resource,
          superScopes
        );

        if (!authorizationResult.authorized) {
          return await wrapResponse(
            request,
            json(
              {
                error: `Unauthorized: ${authorizationResult.reason}`,
                code: "unauthorized",
                param: "access_token",
                type: "authorization",
              },
              { status: 403 }
            ),
            corsStrategy !== "none"
          );
        }
      }

      const resource = options.findResource
        ? await options.findResource(parsedParams, authenticationResult, parsedSearchParams)
        : undefined;

      if (options.findResource && !resource) {
        return await wrapResponse(
          request,
          json({ error: "Resource not found" }, { status: 404 }),
          corsStrategy !== "none"
        );
      }

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
        body: parsedBody,
        authentication: authenticationResult,
        request,
        resource,
      });
      return await wrapResponse(request, result, corsStrategy !== "none");
    } catch (error) {
      try {
        if (error instanceof Response) {
          return await wrapResponse(request, error, corsStrategy !== "none");
        }

        logger.error("Error in action", {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : String(error),
          url: request.url,
        });

        return await wrapResponse(
          request,
          json({ error: "Internal Server Error" }, { status: 500 }),
          corsStrategy !== "none"
        );
      } catch (innerError) {
        logger.error("[apiBuilder] Failed to handle error", { error, innerError });

        return json({ error: "Internal Server Error" }, { status: 500 });
      }
    }
  }

  return { loader, action };
}

async function wrapResponse(
  request: Request,
  response: Response,
  useCors: boolean
): Promise<Response> {
  return useCors
    ? await apiCors(request, response, {
        exposedHeaders: ["x-trigger-jwt", "x-trigger-jwt-claims"],
      })
    : response;
}

type WorkerLoaderRouteBuilderOptions<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
};

type WorkerLoaderHandlerFunction<
  TParamsSchema extends AnyZodSchema | undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
> = (args: {
  params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TParamsSchema>
    : undefined;
  searchParams: TSearchParamsSchema extends
    | z.ZodFirstPartySchemaTypes
    | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TSearchParamsSchema>
    : undefined;
  authenticatedWorker: AuthenticatedWorkerInstance;
  request: Request;
  headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<THeadersSchema>
    : undefined;
  runnerId?: string;
}) => Promise<Response>;

export function createLoaderWorkerApiRoute<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
>(
  options: WorkerLoaderRouteBuilderOptions<TParamsSchema, TSearchParamsSchema, THeadersSchema>,
  handler: WorkerLoaderHandlerFunction<TParamsSchema, TSearchParamsSchema, THeadersSchema>
) {
  return async function loader({ request, params }: LoaderFunctionArgs) {
    const {
      params: paramsSchema,
      searchParams: searchParamsSchema,
      headers: headersSchema,
    } = options;

    try {
      const service = new WorkerGroupTokenService();
      const authenticationResult = await service.authenticate(request);

      if (!authenticationResult) {
        return json({ error: "Invalid or missing worker token" }, { status: 401 });
      }

      let parsedParams: any = undefined;
      if (paramsSchema) {
        const parsed = paramsSchema.safeParse(params);
        if (!parsed.success) {
          return json(
            { error: "Params Error", details: fromZodError(parsed.error).details },
            { status: 400 }
          );
        }
        parsedParams = parsed.data;
      }

      let parsedSearchParams: any = undefined;
      if (searchParamsSchema) {
        const searchParams = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = searchParamsSchema.safeParse(searchParams);
        if (!parsed.success) {
          return json(
            { error: "Query Error", details: fromZodError(parsed.error).details },
            { status: 400 }
          );
        }
        parsedSearchParams = parsed.data;
      }

      let parsedHeaders: any = undefined;
      if (headersSchema) {
        const rawHeaders = Object.fromEntries(request.headers);
        const headers = headersSchema.safeParse(rawHeaders);
        if (!headers.success) {
          return json(
            { error: "Headers Error", details: fromZodError(headers.error).details },
            { status: 400 }
          );
        }
        parsedHeaders = headers.data;
      }

      const runnerId = request.headers.get(WORKER_HEADERS.RUNNER_ID) ?? undefined;

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        authenticatedWorker: authenticationResult,
        request,
        headers: parsedHeaders,
        runnerId,
      });
      return result;
    } catch (error) {
      console.error("Error in API route:", error);
      if (error instanceof Response) {
        return error;
      }

      logger.error("Error in loader", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : String(error),
        url: request.url,
      });

      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  };
}

type WorkerActionRouteBuilderOptions<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TBodySchema extends AnyZodSchema | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  body?: TBodySchema;
  method?: "POST" | "PUT" | "DELETE" | "PATCH";
};

type WorkerActionHandlerFunction<
  TParamsSchema extends AnyZodSchema | undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TBodySchema extends AnyZodSchema | undefined = undefined
> = (args: {
  params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TParamsSchema>
    : undefined;
  searchParams: TSearchParamsSchema extends
    | z.ZodFirstPartySchemaTypes
    | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TSearchParamsSchema>
    : undefined;
  authenticatedWorker: AuthenticatedWorkerInstance;
  request: Request;
  headers: THeadersSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<THeadersSchema>
    : undefined;
  body: TBodySchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    ? z.infer<TBodySchema>
    : undefined;
  runnerId?: string;
}) => Promise<Response>;

export function createActionWorkerApiRoute<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined,
  TBodySchema extends AnyZodSchema | undefined = undefined
>(
  options: WorkerActionRouteBuilderOptions<
    TParamsSchema,
    TSearchParamsSchema,
    THeadersSchema,
    TBodySchema
  >,
  handler: WorkerActionHandlerFunction<
    TParamsSchema,
    TSearchParamsSchema,
    THeadersSchema,
    TBodySchema
  >
) {
  return async function action({ request, params }: ActionFunctionArgs) {
    if (options.method) {
      if (request.method.toUpperCase() !== options.method) {
        return json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: options.method } }
        );
      }
    }

    const {
      params: paramsSchema,
      searchParams: searchParamsSchema,
      body: bodySchema,
      headers: headersSchema,
    } = options;

    try {
      const service = new WorkerGroupTokenService();
      const authenticationResult = await service.authenticate(request);

      if (!authenticationResult) {
        return json({ error: "Invalid or missing worker token" }, { status: 401 });
      }

      let parsedParams: any = undefined;
      if (paramsSchema) {
        const parsed = paramsSchema.safeParse(params);
        if (!parsed.success) {
          return json(
            { error: "Params Error", details: fromZodError(parsed.error).details },
            { status: 400 }
          );
        }
        parsedParams = parsed.data;
      }

      let parsedSearchParams: any = undefined;
      if (searchParamsSchema) {
        const searchParams = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = searchParamsSchema.safeParse(searchParams);
        if (!parsed.success) {
          return json(
            { error: "Query Error", details: fromZodError(parsed.error).details },
            { status: 400 }
          );
        }
        parsedSearchParams = parsed.data;
      }

      let parsedHeaders: any = undefined;
      if (headersSchema) {
        const rawHeaders = Object.fromEntries(request.headers);
        const headers = headersSchema.safeParse(rawHeaders);
        if (!headers.success) {
          return json(
            { error: "Headers Error", details: fromZodError(headers.error).details },
            { status: 400 }
          );
        }
        parsedHeaders = headers.data;
      }

      let parsedBody: any = undefined;
      if (bodySchema) {
        const body = await request.clone().json();
        const parsed = bodySchema.safeParse(body);
        if (!parsed.success) {
          return json(
            { error: "Body Error", details: fromZodError(parsed.error).details },
            { status: 400 }
          );
        }
        parsedBody = parsed.data;
      }

      const runnerId = request.headers.get(WORKER_HEADERS.RUNNER_ID) ?? undefined;

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        authenticatedWorker: authenticationResult,
        request,
        body: parsedBody,
        headers: parsedHeaders,
        runnerId,
      });
      return result;
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      if (error instanceof EngineServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      }

      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      }

      logger.error("Error in action", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : String(error),
        url: request.url,
      });

      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  };
}
