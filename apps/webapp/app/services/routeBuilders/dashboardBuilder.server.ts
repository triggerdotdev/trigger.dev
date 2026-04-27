// Server-only impl backing dashboardBuilder.ts. Imports rbac.server and
// runs the actual auth/authorization. The wrappers in dashboardBuilder.ts
// dynamic-import this module from inside the loader/action body, so it
// never reaches the client bundle.

import { json, redirect } from "@remix-run/server-runtime";
import type { RbacAbility } from "@trigger.dev/rbac";
import { rbac } from "~/services/rbac.server";
import type {
  AuthorizationOption,
  DashboardLoaderOptions,
  SessionUser,
} from "./dashboardBuilder";
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

export async function authenticateAndAuthorize<TParams, TSearchParams>(
  request: Request,
  rawParams: unknown,
  options: DashboardLoaderOptions<TParams, TSearchParams>
): Promise<
  | { ok: false; response: Response }
  | {
      ok: true;
      user: SessionUser;
      ability: RbacAbility;
      params: unknown;
      searchParams: unknown;
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
    return { ok: false, response: redirect(options.unauthorizedRedirect ?? "/") };
  }

  if (options.authorization && !isAuthorized(auth.ability, options.authorization)) {
    return { ok: false, response: redirect(options.unauthorizedRedirect ?? "/") };
  }

  return {
    ok: true,
    user: auth.user,
    ability: auth.ability,
    params: parsedParams,
    searchParams: parsedSearchParams,
  };
}
