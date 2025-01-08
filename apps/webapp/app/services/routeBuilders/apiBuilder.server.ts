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

type ApiKeyRouteBuilderOptions<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined,
  TResource = never
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  allowJWT?: boolean;
  corsStrategy?: "all" | "none";
  findResource: (
    params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined,
    authentication: ApiAuthenticationResultSuccess
  ) => Promise<TResource | undefined>;
  shouldRetryNotFound?: boolean;
  authorization?: {
    action: AuthorizationAction;
    resource: (
      resource: NonNullable<TResource>,
      params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined,
      searchParams: TSearchParamsSchema extends z.AnyZodObject
        ? z.infer<TSearchParamsSchema>
        : undefined,
      headers: THeadersSchema extends z.AnyZodObject ? z.infer<THeadersSchema> : undefined
    ) => AuthorizationResources;
    superScopes?: string[];
  };
};

type ApiKeyHandlerFunction<
  TParamsSchema extends z.AnyZodObject | undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined,
  TResource = never
> = (args: {
  params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined;
  searchParams: TSearchParamsSchema extends z.AnyZodObject
    ? z.infer<TSearchParamsSchema>
    : undefined;
  headers: THeadersSchema extends z.AnyZodObject ? z.infer<THeadersSchema> : undefined;
  authentication: ApiAuthenticationResultSuccess;
  request: Request;
  resource: NonNullable<TResource>;
}) => Promise<Response>;

export function createLoaderApiRoute<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined,
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
      const resource = await findResource(parsedParams, authenticationResult);

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

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
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
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  corsStrategy?: "all" | "none";
};

type PATHandlerFunction<
  TParamsSchema extends z.AnyZodObject | undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined
> = (args: {
  params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined;
  searchParams: TSearchParamsSchema extends z.AnyZodObject
    ? z.infer<TSearchParamsSchema>
    : undefined;
  headers: THeadersSchema extends z.AnyZodObject ? z.infer<THeadersSchema> : undefined;
  authentication: PersonalAccessTokenAuthenticationResult;
  request: Request;
}) => Promise<Response>;

export function createLoaderPATApiRoute<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined
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

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
        authentication: authenticationResult,
        request,
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
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined,
  TBodySchema extends z.AnyZodObject | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  allowJWT?: boolean;
  corsStrategy?: "all" | "none";
  method?: "POST" | "PUT" | "DELETE" | "PATCH";
  authorization?: {
    action: AuthorizationAction;
    resource: (
      params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined,
      searchParams: TSearchParamsSchema extends z.AnyZodObject
        ? z.infer<TSearchParamsSchema>
        : undefined,
      headers: THeadersSchema extends z.AnyZodObject ? z.infer<THeadersSchema> : undefined,
      body: TBodySchema extends z.AnyZodObject ? z.infer<TBodySchema> : undefined
    ) => AuthorizationResources;
    superScopes?: string[];
  };
  maxContentLength?: number;
  body?: TBodySchema;
};

type ApiKeyActionHandlerFunction<
  TParamsSchema extends z.AnyZodObject | undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined,
  TBodySchema extends z.AnyZodObject | undefined = undefined
> = (args: {
  params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined;
  searchParams: TSearchParamsSchema extends z.AnyZodObject
    ? z.infer<TSearchParamsSchema>
    : undefined;
  headers: THeadersSchema extends z.AnyZodObject ? z.infer<THeadersSchema> : undefined;
  body: TBodySchema extends z.AnyZodObject ? z.infer<TBodySchema> : undefined;
  authentication: ApiAuthenticationResultSuccess;
  request: Request;
}) => Promise<Response>;

export function createActionApiRoute<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined,
  THeadersSchema extends z.AnyZodObject | undefined = undefined,
  TBodySchema extends z.AnyZodObject | undefined = undefined
>(
  options: ApiKeyActionRouteBuilderOptions<
    TParamsSchema,
    TSearchParamsSchema,
    THeadersSchema,
    TBodySchema
  >,
  handler: ApiKeyActionHandlerFunction<
    TParamsSchema,
    TSearchParamsSchema,
    THeadersSchema,
    TBodySchema
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

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
        body: parsedBody,
        authentication: authenticationResult,
        request,
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
