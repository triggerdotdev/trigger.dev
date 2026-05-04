import { z } from "zod";
import { ApiAuthenticationResultSuccess } from "../apiAuth.server";
import { ActionFunctionArgs, json, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { fromZodError } from "zod-validation-error";
import { apiCors } from "~/utils/apiCors";
import { logger } from "../logger.server";
import { rbac } from "../rbac.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import type { RbacAbility, RbacResource } from "@trigger.dev/rbac";
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

// Client aborts and service-level validation errors aren't bugs — they're
// expected at API boundaries. Log them at `warn` so they stay in stdout
// without flowing to Sentry via Logger.onError.
function logBoundaryError(
  message: "Error in loader" | "Error in action",
  error: unknown,
  url: string
) {
  const formatted =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : String(error);
  const isExpected =
    error instanceof Error &&
    (error.name === "AbortError" ||
      error instanceof ServiceValidationError ||
      error instanceof EngineServiceValidationError);
  if (isExpected) {
    logger.warn(message, { error: formatted, url });
  } else {
    logger.error(message, { error: formatted, url });
  }
}

// Bridges the RBAC plugin (source of truth for auth + abilities) to the legacy
// ApiAuthenticationResultSuccess shape route handlers still expect. All three
// apiBuilder call sites funnel through this helper — no handler-level changes
// needed.
async function authenticateRequestForApiBuilder(
  request: Request,
  { allowJWT }: { allowJWT: boolean }
): Promise<
  | { ok: false; status: 401; error: string }
  | { ok: true; authentication: ApiAuthenticationResultSuccess; ability: RbacAbility }
> {
  const result = await rbac.authenticateBearer(request, { allowJWT });
  if (!result.ok) {
    return { ok: false, status: 401, error: result.error };
  }

  // The fallback already filters deleted projects; this is belt-and-braces for
  // any race between auth and the follow-up lookup, and fills in the full
  // Prisma-shaped AuthenticatedEnvironment that handlers read from.
  const environment = await findEnvironmentById(result.environment.id);
  if (!environment) {
    return { ok: false, status: 401, error: "Invalid API key" };
  }

  const authentication: ApiAuthenticationResultSuccess = {
    ok: true,
    apiKey: result.environment.apiKey,
    type: result.subject.type === "publicJWT" ? "PUBLIC_JWT" : "PRIVATE",
    environment,
    realtime: result.jwt?.realtime,
    oneTimeUse: result.jwt?.oneTimeUse,
  };

  return { ok: true, authentication, ability: result.ability };
}

type AnyZodSchema = z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;

// Sentinel ability for routes that don't opt into the cap-and-floor PAT
// model — preserves pre-RBAC behaviour where PATs were pure user-identity
// tokens. New routes that want gated PAT auth declare a `context` and
// `authorization` block; the actual ability comes from `rbac.authenticatePat`.
const PERMISSIVE_ABILITY: RbacAbility = {
  can: () => true,
  canSuper: () => false,
};

// A multi-resource auth check has two possible directions, and route authors
// have to pick one explicitly:
//
//  - `anyResource(...)` — succeed if *any* element passes. Used when a single
//    record carries multiple identifiers (a run is addressable by friendlyId /
//    batch / tags / task) so a JWT scoped to *any* of them grants access.
//
//  - `everyResource(...)` — succeed only if *every* element passes. Used for
//    batch operations where each element is a *distinct* resource and a JWT
//    scoped to one element must not authorize the others.
//
// Bare `RbacResource[]` is intentionally *not* part of `AuthResource` — the
// type system forces every multi-resource site to disambiguate. The original
// pre-RBAC apiBuilder had a separate `superScopes: [...]` whitelist for
// "broader-than-this-resource" access; post-RBAC that's expressed via the JWT
// ability's wildcard branches (`*:all` and `admin*` — see
// `internal-packages/rbac/src/ability.ts`) plus a collection-level shape
// `{ type: "<subject>" }` (no id) in the `anyResource` array so a
// `<action>:<subject>` JWT matches it. No code knob needed.
//
// Markers are Symbols so they can't collide with arbitrary RbacResource fields.
const ANY_RESOURCE_MARKER = Symbol.for("@trigger.dev/rbac.anyResource");
const EVERY_RESOURCE_MARKER = Symbol.for("@trigger.dev/rbac.everyResource");

type AnyResourceAuth = {
  readonly [ANY_RESOURCE_MARKER]: true;
  readonly resources: readonly RbacResource[];
};

type EveryResourceAuth = {
  readonly [EVERY_RESOURCE_MARKER]: true;
  readonly resources: readonly RbacResource[];
};

export function anyResource(resources: RbacResource[]): AnyResourceAuth {
  return { [ANY_RESOURCE_MARKER]: true, resources };
}

export function everyResource(resources: RbacResource[]): EveryResourceAuth {
  return { [EVERY_RESOURCE_MARKER]: true, resources };
}

function isAnyResource(value: unknown): value is AnyResourceAuth {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[ANY_RESOURCE_MARKER] === true
  );
}

function isEveryResource(value: unknown): value is EveryResourceAuth {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[EVERY_RESOURCE_MARKER] === true
  );
}

type AuthResource = RbacResource | AnyResourceAuth | EveryResourceAuth;

function checkAuth(
  ability: RbacAbility,
  action: string,
  resource: AuthResource
): boolean {
  if (isEveryResource(resource)) {
    return resource.resources.every((r) => ability.can(action, r));
  }
  if (isAnyResource(resource)) {
    return ability.can(action, [...resource.resources]);
  }
  return ability.can(action, resource);
}

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
    action: string;
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
    ) => AuthResource;
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
      const authResult = await authenticateRequestForApiBuilder(request, { allowJWT });
      if (!authResult.ok) {
        return await wrapResponse(
          request,
          json({ error: authResult.error }, { status: authResult.status }),
          corsStrategy !== "none"
        );
      }
      const { authentication: authenticationResult, ability } = authResult;

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
        const { action, resource: authResource } = authorization;
        const $authResource = authResource(
          resource,
          parsedParams,
          parsedSearchParams,
          parsedHeaders
        );

        if (!checkAuth(ability, action, $authResource)) {
          return await wrapResponse(
            request,
            json(
              {
                error: "Unauthorized",
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

        logBoundaryError("Error in loader", error, request.url);

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
  // Resolves the target org/project for the request. Fed to
  // `rbac.authenticatePat` so the plugin can compute the user's role
  // floor (their authority in that org) for the cap intersection.
  // When omitted, the PAT runs in identity-only mode — no role floor,
  // no per-route ability gating beyond what authorization (if any)
  // declares against a permissive baseline. Routes added before TRI-9087
  // run in this mode by default.
  context?: (
    params: TParamsSchema extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
      ? z.infer<TParamsSchema>
      : undefined,
    request: Request
  ) =>
    | { organizationId?: string; projectId?: string }
    | Promise<{ organizationId?: string; projectId?: string }>;
  authorization?: {
    action: string;
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
        : undefined
    ) => AuthResource;
  };
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
  ability: RbacAbility;
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
      context: contextFn,
      authorization,
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

      // Resolve ability via the rbac plugin. When neither `context` nor
      // `authorization` is declared, the legacy permissive ability stands
      // in — preserves the pre-RBAC PAT behaviour for routes that
      // haven't opted into the cap-and-floor model yet.
      let ability: RbacAbility = PERMISSIVE_ABILITY;
      if (contextFn || authorization) {
        const ctx = contextFn ? await contextFn(parsedParams, request) : {};
        const patAuth = await rbac.authenticatePat(request, ctx);
        if (!patAuth.ok) {
          return await wrapResponse(
            request,
            json({ error: patAuth.error }, { status: patAuth.status }),
            corsStrategy !== "none"
          );
        }
        ability = patAuth.ability;

        if (authorization) {
          const $resource = authorization.resource(
            parsedParams,
            parsedSearchParams,
            parsedHeaders
          );
          if (!checkAuth(ability, authorization.action, $resource)) {
            return await wrapResponse(
              request,
              json(
                {
                  error: "Unauthorized",
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
      }

      const result = await handler({
        params: parsedParams,
        searchParams: parsedSearchParams,
        headers: parsedHeaders,
        authentication: authenticationResult,
        ability,
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
    action: string;
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
        : undefined,
      // The resolved resource from `findResource`. `undefined` when the route
      // doesn't declare `findResource`. Routes that need to expand the auth
      // scope to alternate identifiers of the same row (e.g. friendlyId +
      // externalId for sessions) read it here so a JWT minted for either form
      // authorizes both URL forms.
      resource: TResource | undefined
    ) => AuthResource;
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
      const authResult = await authenticateRequestForApiBuilder(request, { allowJWT });
      if (!authResult.ok) {
        return await wrapResponse(
          request,
          json({ error: authResult.error }, { status: authResult.status }),
          corsStrategy !== "none"
        );
      }
      const { authentication: authenticationResult, ability } = authResult;

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

      // Resolve the resource before authorization so the auth scope check
      // can expand to alternate identifiers of the same row (e.g. a Session
      // is addressable by both `friendlyId` and `externalId` and a JWT minted
      // for either form should authorize both URL forms). Mirrors the
      // ordering in `createLoaderApiRoute`.
      const resource = options.findResource
        ? await options.findResource(parsedParams, authenticationResult, parsedSearchParams)
        : undefined;

      // Run authorization first — but with the resolved resource available
      // as the 5th arg so the auth scope check can expand to alternate
      // identifiers of the same row (e.g. a Session is addressable by both
      // `friendlyId` and `externalId`). Resource-null is checked AFTER auth
      // so:
      //   - underscoped JWT + missing resource → 403 (no info leak)
      //   - underscoped JWT + existing resource → 403 (existing behavior)
      //   - PRIVATE key + missing resource → auth passes → 404 (correct)
      //   - PRIVATE key + existing resource → auth passes → handler runs
      if (authorization) {
        const { action, resource: authResource } = authorization;
        const $resource = authResource(
          parsedParams,
          parsedSearchParams,
          parsedHeaders,
          parsedBody,
          resource
        );

        if (!checkAuth(ability, action, $resource)) {
          return await wrapResponse(
            request,
            json(
              {
                error: "Unauthorized",
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

        logBoundaryError("Error in action", error, request.url);

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

// ---------------------------------------------------------------------------
// Multi-method action route builder
// ---------------------------------------------------------------------------

type HttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

type InferZod<T> = T extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
  ? z.infer<T>
  : undefined;

type MethodHandlerArgs<TParamsSchema, TSearchParamsSchema, THeadersSchema, TBodySchema> = {
  params: InferZod<TParamsSchema>;
  searchParams: InferZod<TSearchParamsSchema>;
  headers: InferZod<THeadersSchema>;
  body: InferZod<TBodySchema>;
  authentication: ApiAuthenticationResultSuccess;
  request: Request;
};

type MethodConfig<TParamsSchema, TSearchParamsSchema, THeadersSchema> = {
  body?: AnyZodSchema;
  handler: (
    args: MethodHandlerArgs<TParamsSchema, TSearchParamsSchema, THeadersSchema, any>
  ) => Promise<Response>;
};

type MultiMethodApiRouteOptions<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
> = {
  params?: TParamsSchema;
  searchParams?: TSearchParamsSchema;
  headers?: THeadersSchema;
  allowJWT?: boolean;
  corsStrategy?: "all" | "none";
  authorization?: {
    action: string;
    resource: (params: InferZod<TParamsSchema>) => AuthResource;
  };
  maxContentLength?: number;
  methods: Partial<
    Record<HttpMethod, MethodConfig<TParamsSchema, TSearchParamsSchema, THeadersSchema>>
  >;
};

/**
 * Creates a Remix route that dispatches to different handlers based on HTTP method.
 * Shares authentication, param parsing, CORS, and authorization across all methods.
 * Each method can define its own body schema.
 */
export function createMultiMethodApiRoute<
  TParamsSchema extends AnyZodSchema | undefined = undefined,
  TSearchParamsSchema extends AnyZodSchema | undefined = undefined,
  THeadersSchema extends AnyZodSchema | undefined = undefined
>(options: MultiMethodApiRouteOptions<TParamsSchema, TSearchParamsSchema, THeadersSchema>) {
  const {
    params: paramsSchema,
    searchParams: searchParamsSchema,
    headers: headersSchema,
    allowJWT = false,
    corsStrategy = "none",
    authorization,
    maxContentLength,
    methods,
  } = options;

  const allowedMethods = Object.keys(methods).join(", ");

  async function loader({ request }: LoaderFunctionArgs) {
    if (corsStrategy !== "none" && request.method.toUpperCase() === "OPTIONS") {
      return apiCors(request, json({}));
    }
    return new Response(null, { status: 405 });
  }

  async function action({ request, params }: ActionFunctionArgs) {
    const method = request.method.toUpperCase() as HttpMethod;
    const methodConfig = methods[method];

    if (!methodConfig) {
      return await wrapResponse(
        request,
        json({ error: "Method not allowed" }, { status: 405, headers: { Allow: allowedMethods } }),
        corsStrategy !== "none"
      );
    }

    try {
      // Authenticate
      const authResult = await authenticateRequestForApiBuilder(request, { allowJWT });
      if (!authResult.ok) {
        return await wrapResponse(
          request,
          json({ error: authResult.error }, { status: authResult.status }),
          corsStrategy !== "none"
        );
      }
      const { authentication: authenticationResult, ability } = authResult;

      if (maxContentLength) {
        const contentLength = request.headers.get("content-length");
        if (!contentLength || parseInt(contentLength) > maxContentLength) {
          return await wrapResponse(
            request,
            json({ error: "Request body too large" }, { status: 413 }),
            corsStrategy !== "none"
          );
        }
      }

      // Parse params
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

      // Parse search params
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

      // Parse headers
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

      // Authorize
      if (authorization) {
        const { action, resource } = authorization;
        const $resource = resource(parsedParams);

        if (!checkAuth(ability, action, $resource)) {
          return await wrapResponse(
            request,
            json(
              {
                error: "Unauthorized",
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

      // Parse body (per-method schema)
      let parsedBody: any = undefined;
      if (methodConfig.body) {
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

        const body = methodConfig.body.safeParse(rawParsedJson);
        if (!body.success) {
          return await wrapResponse(
            request,
            json({ error: fromZodError(body.error).toString() }, { status: 400 }),
            corsStrategy !== "none"
          );
        }
        parsedBody = body.data;
      }

      // Dispatch to method handler
      const result = await methodConfig.handler({
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

        logBoundaryError("Error in action", error, request.url);

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

      logBoundaryError("Error in loader", error, request.url);

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

      logBoundaryError("Error in action", error, request.url);

      return json({ error: "Internal Server Error" }, { status: 500 });
    }
  };
}
