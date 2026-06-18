// Server-only impl backing dashboardBuilder.ts. Imports rbac.server and
// runs the actual auth/authorization. The wrappers in dashboardBuilder.ts
// dynamic-import this module from inside the loader/action body, so it
// never reaches the client bundle.

import { json, redirect } from "@remix-run/server-runtime";
import type { RbacAbility } from "@trigger.dev/rbac";
import { rbac } from "~/services/rbac.server";
import { getUserId } from "~/services/session.server";
import { permissionDeniedResponse } from "~/utils/permissionDenied";
import type { AuthorizationOption, DashboardLoaderOptions, SessionUser } from "./dashboardBuilder";
import { fromZodError } from "zod-validation-error";
import type { z } from "zod";

type AnyZodSchema = z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;

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

type AuthScope = { organizationId?: string; projectId?: string };

export async function authenticateAndAuthorize<TParams, TSearchParams, TContext extends AuthScope>(
  request: Request,
  rawParams: unknown,
  options: DashboardLoaderOptions<TParams, TSearchParams, TContext>
): Promise<
  | { ok: false; response: Response }
  | {
      ok: true;
      user: SessionUser;
      ability: RbacAbility;
      params: unknown;
      searchParams: unknown;
      context: TContext;
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

  const ctx = (
    options.context ? await options.context(parsedParams, request) : ({} as TContext)
  ) as TContext;
  // Resolve userId from the session cookie *here* (the dashboard
  // request boundary) and feed it into the rbac plugin context. The
  // plugin no longer takes a `helpers.getSessionUserId` callback —
  // statically importing session.server from rbac.server dragged the
  // entire remix-auth strategy chain (each strategy validates its
  // secret at module load) into anything that pulled `rbac` in,
  // including PAT-only callers.
  const userId = (await getUserId(request)) ?? null;
  const auth = await rbac.authenticateSession(request, { ...ctx, userId });
  if (!auth.ok) {
    if (auth.reason === "unauthenticated") {
      return { ok: false, response: loginRedirectFor(request, options.loginRedirect) };
    }
    return { ok: false, response: redirect(options.unauthorizedRedirect ?? "/") };
  }

  if (options.authorization) {
    const isSuperGate = "requireSuper" in options.authorization;
    // Every catalogue resource is org- or project-scoped; requireSuper is the
    // only global gate. An org/project-scoped check with no resolved scope
    // would evaluate an unscoped ability, making the authorization a silent
    // no-op for a missing org. Fail closed instead of relying on the ability
    // to happen to deny.
    const hasScope = Boolean(ctx.organizationId || ctx.projectId);
    const denied = isSuperGate
      ? !isAuthorized(auth.ability, options.authorization)
      : !hasScope || !isAuthorized(auth.ability, options.authorization);

    if (denied) {
      // Super-admin gates must not reveal that the route exists, so they
      // redirect away rather than render the panel. A redirect is also used by
      // routes that opt in via unauthorizedRedirect (credential endpoints with
      // no UI).
      if (options.unauthorizedRedirect || isSuperGate) {
        return { ok: false, response: redirect(options.unauthorizedRedirect ?? "/") };
      }
      // Role-based denial: throw a permission-denied 403. Both loader and
      // action wrappers throw this, so it bubbles to the nearest route
      // ErrorBoundary, where RouteErrorDisplay renders the permission panel.
      return { ok: false, response: permissionDeniedResponse(options.authorization.message) };
    }
  }

  return {
    ok: true,
    user: auth.user,
    ability: auth.ability,
    params: parsedParams,
    searchParams: parsedSearchParams,
    context: ctx,
  };
}
