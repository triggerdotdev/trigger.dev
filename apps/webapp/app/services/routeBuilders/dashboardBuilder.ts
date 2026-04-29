// Client-safe shim for the dashboard route builder. The actual server
// implementation lives in dashboardBuilder.server.ts; the wrappers here
// just return closures that lazily import that impl on first invocation.
//
// Why split: routes use `export const loader = dashboardLoader(...)` at
// module top-level. Remix's dev build preserves the top-level call when
// resolving the loader export, so the import target needs to exist on
// the client even though the closure body never executes there. A
// `.server.ts` file is excluded from the client bundle, which would
// resolve `dashboardLoader` to undefined and crash with
// "dashboardLoader is not a function" on first navigation. Keeping this
// file non-`.server` puts the wrappers in the client bundle as
// effectively no-op closures (they're never called there), and the
// closure body's dynamic import only resolves at server runtime.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { RbacAbility, RbacResource } from "@trigger.dev/rbac";
import type { z } from "zod";

type AnyZodSchema = z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;

type InferZod<T> = T extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
  ? z.infer<T>
  : undefined;

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  admin: boolean;
  confirmedBasicDetails: boolean;
  isImpersonating: boolean;
};

// `requireSuper: true` enforces ability.canSuper(). Otherwise an explicit
// action + resource pair is checked via ability.can(...).
export type AuthorizationOption =
  | { requireSuper: true }
  | {
      action: string;
      resource: RbacResource | RbacResource[];
    };

export type DashboardLoaderOptions<TParams, TSearchParams> = {
  params?: TParams;
  searchParams?: TSearchParams;
  // Optional: provides organizationId / projectId to rbac.authenticateSession
  // when the route's ability check needs it. The default fallback
  // ignores context; an installed plugin may use it to scope the
  // returned ability.
  context?: (
    params: InferZod<TParams>,
    request: Request
  ) =>
    | { organizationId?: string; projectId?: string }
    | Promise<{ organizationId?: string; projectId?: string }>;
  authorization?: AuthorizationOption;
  // Where to send unauthenticated requests. Defaults to /login with a
  // redirectTo back to the original path.
  loginRedirect?: string;
  // Where to send users who pass auth but fail the ability check. Defaults
  // to "/" (the home page).
  unauthorizedRedirect?: string;
};

export type DashboardLoaderHandlerArgs<TParams, TSearchParams> = {
  params: InferZod<TParams>;
  searchParams: InferZod<TSearchParams>;
  user: SessionUser;
  ability: RbacAbility;
  request: Request;
};

export function dashboardLoader<
  TParams extends AnyZodSchema | undefined = undefined,
  TSearchParams extends AnyZodSchema | undefined = undefined,
  TReturn extends Response = Response
>(
  options: DashboardLoaderOptions<TParams, TSearchParams>,
  handler: (args: DashboardLoaderHandlerArgs<TParams, TSearchParams>) => Promise<TReturn>
) {
  return async function loader({ request, params }: LoaderFunctionArgs): Promise<TReturn> {
    // Server-only — see comment at top. Node caches the module after the
    // first call, so the dynamic import is effectively free past warmup.
    const { authenticateAndAuthorize } = await import("./dashboardBuilder.server");
    const result = await authenticateAndAuthorize(request, params, options);
    if (!result.ok) throw result.response;

    return handler({
      params: result.params as InferZod<TParams>,
      searchParams: result.searchParams as InferZod<TSearchParams>,
      user: result.user,
      ability: result.ability,
      request,
    });
  };
}

export type DashboardActionOptions<TParams, TSearchParams> = DashboardLoaderOptions<
  TParams,
  TSearchParams
>;

export type DashboardActionHandlerArgs<TParams, TSearchParams> = DashboardLoaderHandlerArgs<
  TParams,
  TSearchParams
> & {
  request: Request;
};

export function dashboardAction<
  TParams extends AnyZodSchema | undefined = undefined,
  TSearchParams extends AnyZodSchema | undefined = undefined,
  TReturn extends Response = Response
>(
  options: DashboardActionOptions<TParams, TSearchParams>,
  handler: (args: DashboardActionHandlerArgs<TParams, TSearchParams>) => Promise<TReturn>
) {
  return async function action({ request, params }: ActionFunctionArgs): Promise<TReturn> {
    const { authenticateAndAuthorize } = await import("./dashboardBuilder.server");
    const result = await authenticateAndAuthorize(request, params, options);
    if (!result.ok) throw result.response;

    return handler({
      params: result.params as InferZod<TParams>,
      searchParams: result.searchParams as InferZod<TSearchParams>,
      user: result.user,
      ability: result.ability,
      request,
    });
  };
}
