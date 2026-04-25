import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
  redirect,
} from "@remix-run/server-runtime";
import type { RbacAbility, RbacResource } from "@trigger.dev/rbac";
import type { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { rbac } from "~/services/rbac.server";

// The dashboard counterpart to apiBuilder. Routes that need session auth
// (with optional admin / ability checks) opt in by exporting their
// loader/action via dashboardLoader / dashboardAction. Routes that just
// need a logged-in user with no authorisation can keep using requireUser.

type AnyZodSchema = z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;

type InferZod<T> = T extends z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
  ? z.infer<T>
  : undefined;

type SessionUser = {
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
type AuthorizationOption =
  | { requireSuper: true }
  | {
      action: string;
      resource: RbacResource | RbacResource[];
    };

type DashboardLoaderOptions<TParams, TSearchParams> = {
  params?: TParams;
  searchParams?: TSearchParams;
  // Optional: provides organizationId / projectId to rbac.authenticateSession
  // when the route's ability check needs it (enterprise-only — fallback
  // currently ignores context).
  context?: (
    params: InferZod<TParams>,
    request: Request
  ) => { organizationId?: string; projectId?: string } | Promise<{ organizationId?: string; projectId?: string }>;
  authorization?: AuthorizationOption;
  // Where to send unauthenticated requests. Defaults to /login with a
  // redirectTo back to the original path.
  loginRedirect?: string;
  // Where to send users who pass auth but fail the ability check. Defaults
  // to "/" (the home page).
  unauthorizedRedirect?: string;
};

type DashboardLoaderHandlerArgs<TParams, TSearchParams> = {
  params: InferZod<TParams>;
  searchParams: InferZod<TSearchParams>;
  user: SessionUser;
  ability: RbacAbility;
  request: Request;
};

function loginRedirectFor(request: Request, override?: string): Response {
  if (override) return redirect(override);
  const url = new URL(request.url);
  const redirectTo = encodeURIComponent(`${url.pathname}${url.search}`);
  return redirect(`/login?redirectTo=${redirectTo}`);
}

function isAuthorized(ability: RbacAbility, authorization: AuthorizationOption): boolean {
  if ("requireSuper" in authorization) {
    return ability.canSuper();
  }
  return ability.can(authorization.action, authorization.resource);
}

async function authenticateAndAuthorize<TParams, TSearchParams>(
  request: Request,
  rawParams: unknown,
  options: DashboardLoaderOptions<TParams, TSearchParams>
): Promise<
  | { ok: false; response: Response }
  | {
      ok: true;
      user: SessionUser;
      ability: RbacAbility;
      params: InferZod<TParams>;
      searchParams: InferZod<TSearchParams>;
    }
> {
  let parsedParams: any = undefined;
  if (options.params) {
    const parsed = (options.params as unknown as AnyZodSchema).safeParse(rawParams);
    if (!parsed.success) {
      return {
        ok: false,
        response: json(
          { error: "Params Error", details: fromZodError(parsed.error).details },
          { status: 400 }
        ),
      };
    }
    parsedParams = parsed.data;
  }

  let parsedSearchParams: any = undefined;
  if (options.searchParams) {
    const fromUrl = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = (options.searchParams as unknown as AnyZodSchema).safeParse(fromUrl);
    if (!parsed.success) {
      return {
        ok: false,
        response: json(
          { error: "Query Error", details: fromZodError(parsed.error).details },
          { status: 400 }
        ),
      };
    }
    parsedSearchParams = parsed.data;
  }

  const ctx = options.context ? await options.context(parsedParams, request) : {};
  const auth = await rbac.authenticateSession(request, ctx);
  if (!auth.ok) {
    if (auth.reason === "unauthenticated") {
      return { ok: false, response: loginRedirectFor(request, options.loginRedirect) };
    }
    return {
      ok: false,
      response: redirect(options.unauthorizedRedirect ?? "/"),
    };
  }

  if (options.authorization && !isAuthorized(auth.ability, options.authorization)) {
    return {
      ok: false,
      response: redirect(options.unauthorizedRedirect ?? "/"),
    };
  }

  return {
    ok: true,
    user: auth.user,
    ability: auth.ability,
    params: parsedParams,
    searchParams: parsedSearchParams,
  };
}

export function dashboardLoader<
  TParams extends AnyZodSchema | undefined = undefined,
  TSearchParams extends AnyZodSchema | undefined = undefined,
  TReturn extends Response = Response
>(
  options: DashboardLoaderOptions<TParams, TSearchParams>,
  handler: (args: DashboardLoaderHandlerArgs<TParams, TSearchParams>) => Promise<TReturn>
) {
  return async function loader({ request, params }: LoaderFunctionArgs): Promise<TReturn> {
    const result = await authenticateAndAuthorize(request, params, options);
    // Auth/authorization failure is signalled by throwing the redirect/json
    // response. This keeps the loader's success-path return type narrow so
    // useTypedLoaderData<typeof loader>() picks up the handler's TypedResponse.
    if (!result.ok) throw result.response;

    return handler({
      params: result.params,
      searchParams: result.searchParams,
      user: result.user,
      ability: result.ability,
      request,
    });
  };
}

type DashboardActionOptions<TParams, TSearchParams> = DashboardLoaderOptions<TParams, TSearchParams>;

type DashboardActionHandlerArgs<TParams, TSearchParams> = DashboardLoaderHandlerArgs<TParams, TSearchParams> & {
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
    const result = await authenticateAndAuthorize(request, params, options);
    if (!result.ok) throw result.response;

    return handler({
      params: result.params,
      searchParams: result.searchParams,
      user: result.user,
      ability: result.ability,
      request,
    });
  };
}
