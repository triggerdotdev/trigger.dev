import { z } from "zod";
import { ApiAuthenticationResult, authenticateApiRequest } from "../apiAuth.server";
import { json, LoaderFunctionArgs } from "@remix-run/server-runtime";
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
import {
  AuthenticatedWorkerInstance,
  WorkerGroupTokenService,
} from "~/v3/services/worker/workerGroupTokenService.server";

type ApiKeyRouteBuilderOptions<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  allowJWT?: boolean;
  corsStrategy?: "all" | "none";
  authorization?: {
    action: AuthorizationAction;
    resource: (
      params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined,
      searchParams: TSearchParamsSchema extends z.AnyZodObject
        ? z.infer<TSearchParamsSchema>
        : undefined
    ) => AuthorizationResources;
    superScopes?: string[];
  };
};

type ApiKeyHandlerFunction<
  TParamsSchema extends z.AnyZodObject | undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined
> = (args: {
  params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined;
  searchParams: TSearchParamsSchema extends z.AnyZodObject
    ? z.infer<TSearchParamsSchema>
    : undefined;
  authentication: ApiAuthenticationResult;
  request: Request;
}) => Promise<Response>;

export function createLoaderApiRoute<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined
>(
  options: ApiKeyRouteBuilderOptions<TParamsSchema, TSearchParamsSchema>,
  handler: ApiKeyHandlerFunction<TParamsSchema, TSearchParamsSchema>
) {
  return async function loader({ request, params }: LoaderFunctionArgs) {
    const {
      params: paramsSchema,
      searchParams: searchParamsSchema,
      allowJWT = false,
      corsStrategy = "none",
      authorization,
    } = options;

    if (corsStrategy !== "none" && request.method.toUpperCase() === "OPTIONS") {
      return apiCors(request, json({}));
    }

    const authenticationResult = await authenticateApiRequest(request, { allowJWT });

    if (!authenticationResult) {
      return wrapResponse(
        request,
        json({ error: "Invalid or Missing API key" }, { status: 401 }),
        corsStrategy !== "none"
      );
    }

    let parsedParams: any = undefined;
    if (paramsSchema) {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return wrapResponse(
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
        return wrapResponse(
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

    if (authorization) {
      const { action, resource, superScopes } = authorization;
      const $resource = resource(parsedParams, parsedSearchParams);

      logger.debug("Checking authorization", {
        action,
        resource: $resource,
        superScopes,
        scopes: authenticationResult.scopes,
      });

      if (!checkAuthorization(authenticationResult, action, $resource, superScopes)) {
        return wrapResponse(
          request,
          json({ error: "Unauthorized" }, { status: 403 }),
          corsStrategy !== "none"
        );
      }
    }

    try {
      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        authentication: authenticationResult,
        request,
      });
      return wrapResponse(request, result, corsStrategy !== "none");
    } catch (error) {
      console.error("Error in API route:", error);
      if (error instanceof Response) {
        return wrapResponse(request, error, corsStrategy !== "none");
      }
      return wrapResponse(
        request,
        json({ error: "Internal Server Error" }, { status: 500 }),
        corsStrategy !== "none"
      );
    }
  };
}

type PATRouteBuilderOptions<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  corsStrategy?: "all" | "none";
};

type PATHandlerFunction<
  TParamsSchema extends z.AnyZodObject | undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined
> = (args: {
  params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined;
  searchParams: TSearchParamsSchema extends z.AnyZodObject
    ? z.infer<TSearchParamsSchema>
    : undefined;
  authentication: PersonalAccessTokenAuthenticationResult;
  request: Request;
}) => Promise<Response>;

export function createLoaderPATApiRoute<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined
>(
  options: PATRouteBuilderOptions<TParamsSchema, TSearchParamsSchema>,
  handler: PATHandlerFunction<TParamsSchema, TSearchParamsSchema>
) {
  return async function loader({ request, params }: LoaderFunctionArgs) {
    const {
      params: paramsSchema,
      searchParams: searchParamsSchema,
      corsStrategy = "none",
    } = options;

    if (corsStrategy !== "none" && request.method.toUpperCase() === "OPTIONS") {
      return apiCors(request, json({}));
    }

    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return wrapResponse(
        request,
        json({ error: "Invalid or Missing API key" }, { status: 401 }),
        corsStrategy !== "none"
      );
    }

    let parsedParams: any = undefined;
    if (paramsSchema) {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return wrapResponse(
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
        return wrapResponse(
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

    try {
      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        authentication: authenticationResult,
        request,
      });
      return wrapResponse(request, result, corsStrategy !== "none");
    } catch (error) {
      console.error("Error in API route:", error);
      if (error instanceof Response) {
        return wrapResponse(request, error, corsStrategy !== "none");
      }
      return wrapResponse(
        request,
        json({ error: "Internal Server Error" }, { status: 500 }),
        corsStrategy !== "none"
      );
    }
  };
}

function wrapResponse(request: Request, response: Response, useCors: boolean) {
  return useCors ? apiCors(request, response) : response;
}

type WorkerRouteBuilderOptions<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
};

type WorkerHandlerFunction<
  TParamsSchema extends z.AnyZodObject | undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined
> = (args: {
  params: TParamsSchema extends z.AnyZodObject ? z.infer<TParamsSchema> : undefined;
  searchParams: TSearchParamsSchema extends z.AnyZodObject
    ? z.infer<TSearchParamsSchema>
    : undefined;
  authenticatedWorker: AuthenticatedWorkerInstance;
  request: Request;
}) => Promise<Response>;

export function createLoaderWorkerApiRoute<
  TParamsSchema extends z.AnyZodObject | undefined = undefined,
  TSearchParamsSchema extends z.AnyZodObject | undefined = undefined
>(
  options: WorkerRouteBuilderOptions<TParamsSchema, TSearchParamsSchema>,
  handler: WorkerHandlerFunction<TParamsSchema, TSearchParamsSchema>
) {
  return async function loader({ request, params }: LoaderFunctionArgs) {
    const { params: paramsSchema, searchParams: searchParamsSchema } = options;

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

    try {
      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        authenticatedWorker: authenticationResult,
        request,
      });
      return result;
    } catch (error) {
      console.error("Error in API route:", error);
      if (error instanceof Response) {
        return error;
      }
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  };
}
