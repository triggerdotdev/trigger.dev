import { logger } from "@trigger.dev/sdk";
import { DASHBOARD_AGENT_ENV_JWT_SCOPES } from "./tool-schemas.js";

/**
 * The agent's HTTP surface: the delegated-token GET, the env-JWT exchange and its
 * turn-scoped cache, and the query POST both `run_query` and chart validation use.
 */

// A status is the server's answer; a transport failure is the absence of one, and must never
// be read as a definite 404.
export type FetchResult =
  | { ok: true; data: unknown }
  // `data` is best-effort: present only when the error response had a parseable JSON body (e.g.
  // locate's 404 carries `{ found: false, truncated: true }`), absent otherwise.
  | { ok: false; status: number; data?: unknown }
  | { ok: false; transport: string };

/** How a failed GET is phrased, so "couldn't read" never reads as "isn't there". */
export function fetchReason(result: { status: number } | { transport: string }): string {
  return "transport" in result
    ? ` (the request failed: ${result.transport})`
    : ` (status ${result.status})`;
}

/**
 * Why an environment-scoped call was never made. Only `"missing"` says there is no current
 * environment; `"unknown"` is an exchange that failed, which is not evidence of absence.
 */
export type EnvUnavailable =
  | { ok: false; envUnavailable: "missing" }
  | { ok: false; envUnavailable: "unknown"; status?: number };

export type EnvFetchResult = FetchResult | EnvUnavailable;

export function isEnvUnavailable(result: object): result is EnvUnavailable {
  return "envUnavailable" in result;
}

const MISSING_ENV: EnvUnavailable = { ok: false, envUnavailable: "missing" };

// Node's fetch has no default timeout, so a stalled connection would hang the tool loop
// forever. A timeout aborts the fetch, which throws and is caught as a transport failure.
const GET_TIMEOUT_MS = 10_000;
const JWT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

// "query" is the server rejecting the TRQL, "transport" is the request breaking, "busy" is
// the server too loaded or rate limited to answer — the same query may work shortly. Chart
// validation only fails a render on "query".
type QueryPostResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; kind: "query" | "transport" | "busy"; error: string };

export const NO_AUTH = { error: "No delegated access is available for this turn." } as const;

// `branch` is needed on the name-addressed routes: `preview`/`dev` resolve to the parent
// environment unless the branch travels with them, and a branch-scoped token then 403s.
export async function apiGet(
  origin: string,
  path: string,
  token: string,
  branch?: string
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (branch) headers["x-trigger-branch"] = branch;
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, transport: (error as Error).message };
  }
  if (!res.ok) {
    try {
      return { ok: false, status: res.status, data: await res.json() };
    } catch {
      return { ok: false, status: res.status };
    }
  }
  try {
    return { ok: true, data: await res.json() };
  } catch (error) {
    return { ok: false, transport: (error as Error).message };
  }
}

/** Which environment a read is aimed at. Explicit on every call: one turn may read two. */
export type EnvTarget = { projectRef: string; environmentName: string; branch?: string };

// The exchange ceilings these scopes to the delegated token's read-only cap, so the
// JWT can never widen the grant.
async function exchangeEnvJwt(
  origin: string,
  userActorToken: string,
  target: EnvTarget
): Promise<{ ok: true; token: string; environmentId?: string } | EnvUnavailable> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${userActorToken}`,
    "Content-Type": "application/json",
  };
  if (target.branch) headers["x-trigger-branch"] = target.branch;
  const path = `/api/v1/projects/${encodeURIComponent(target.projectRef)}/${encodeURIComponent(
    target.environmentName
  )}/jwt`;
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ claims: { scopes: [...DASHBOARD_AGENT_ENV_JWT_SCOPES] } }),
      signal: AbortSignal.timeout(JWT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, envUnavailable: "unknown" };
  }
  if (!res.ok) return { ok: false, envUnavailable: "unknown", status: res.status };
  const data = (await res.json().catch(() => ({}))) as { token?: string; environmentId?: string };
  if (!data.token) return { ok: false, envUnavailable: "unknown" };
  return { ok: true, token: data.token, environmentId: data.environmentId };
}

export type DashboardAgentApiClient = {
  /** The API origin with any trailing slash removed. Empty when none was injected. */
  origin: string;
  /** Whether this turn has both a delegated token and an origin to spend it on. */
  hasAuth: boolean;
  /** A GET as the target's environment JWT, or why no environment JWT could be made. */
  envApiGet(path: string, target: EnvTarget): Promise<EnvFetchResult>;
  postQuery(
    query: string,
    period: string | undefined,
    target: EnvTarget
  ): Promise<QueryPostResult | EnvUnavailable>;
  validateChartQuery(
    query: string,
    period: string | undefined,
    target: EnvTarget | undefined
  ): Promise<string | null>;
  /** The RuntimeEnvironment id the exchange resolved the target to, when it landed. */
  environmentIdFor(target: EnvTarget): Promise<string | undefined>;
};

export type ApiClientContext = {
  userActorToken?: string;
  apiOrigin?: string;
  // Fallback identity only, for an exchange that answered without an `environmentId`
  // (a webapp from before that field, mid-deploy) — never a target itself.
  projectRef?: string;
  environmentName?: string;
  environmentBranch?: string;
  environmentId?: string;
};

export function createApiClient(ctx: ApiClientContext): DashboardAgentApiClient {
  const { userActorToken, apiOrigin } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // A different target keeps failing closed: cross-target evidence may never guess its scope.
  function conversationEnvironmentId(target: EnvTarget): string | undefined {
    const sameEnvironment =
      target.projectRef === ctx.projectRef &&
      target.environmentName === ctx.environmentName &&
      (target.branch || undefined) === (ctx.environmentBranch || undefined);
    return sameEnvironment ? ctx.environmentId : undefined;
  }

  // Turn-scoped, since the tool set is rebuilt per turn, and keyed by the whole target,
  // branch included. Caching the promise makes concurrent calls share one exchange.
  type EnvJwt = { ok: true; token: string; environmentId: string } | EnvUnavailable;
  const envJwts = new Map<string, Promise<EnvJwt>>();
  function getEnvJwt(target: EnvTarget, refresh = false): Promise<EnvJwt> {
    if (!hasAuth) return Promise.resolve(MISSING_ENV);
    const key = `${target.projectRef}/${target.environmentName}/${target.branch ?? ""}`;
    if (refresh) envJwts.delete(key);
    let pending = envJwts.get(key);
    if (!pending) {
      // A failed exchange is not cached: a 403 or a 5xx would otherwise pin the whole turn.
      pending = exchangeEnvJwt(origin, userActorToken!, target).then((result) => {
        if (!result.ok) {
          envJwts.delete(key);
          return result;
        }
        // Without an id the read would work while every scope it is evidence for silently
        // degrades, so an exchange that names no environment is a failed exchange.
        const environmentId = result.environmentId ?? conversationEnvironmentId(target);
        if (!environmentId) {
          envJwts.delete(key);
          return { ok: false, envUnavailable: "unknown" } satisfies EnvUnavailable;
        }
        return { ok: true, token: result.token, environmentId };
      });
      envJwts.set(key, pending);
    }
    return pending;
  }

  /**
   * On an unauthorized result the cache entry is dropped and the call is retried once,
   * since a token can be minted stale.
   */
  async function withEnvJwt<T extends object>(
    target: EnvTarget,
    call: (jwt: string) => Promise<T>,
    isUnauthorized: (result: T) => boolean
  ): Promise<T | EnvUnavailable> {
    const jwt = await getEnvJwt(target);
    if (!jwt.ok) return jwt;
    const first = await call(jwt.token);
    if (!isUnauthorized(first)) return first;
    const fresh = await getEnvJwt(target, true);
    if (!fresh.ok) return first;
    return call(fresh.token);
  }

  const unauthorizedGet = (result: FetchResult) =>
    !result.ok && "status" in result && result.status === 401;

  function envApiGet(path: string, target: EnvTarget): Promise<EnvFetchResult> {
    return withEnvJwt(target, (jwt) => apiGet(origin, path, jwt), unauthorizedGet);
  }

  async function environmentIdFor(target: EnvTarget): Promise<string | undefined> {
    const jwt = await getEnvJwt(target);
    return jwt.ok ? jwt.environmentId : undefined;
  }

  // A POST, so it can't use envApiGet, but keeps the same JWT cache and one-shot
  // re-exchange on a 401. Shared by run_query and chart-block validation.
  async function postQuery(
    query: string,
    period: string | undefined,
    target: EnvTarget
  ): Promise<QueryPostResult | EnvUnavailable> {
    const attempt = await withEnvJwt<{ res: Response } | { error: string }>(
      target,
      async (jwt) => {
        try {
          return {
            res: await fetch(`${origin}/api/v1/query`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({ query, scope: "environment", period, format: "json" }),
              signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
            }),
          };
        } catch (error) {
          return { error: `Query request failed: ${(error as Error).message}` };
        }
      },
      (result) => "res" in result && result.res.status === 401
    );
    if (isEnvUnavailable(attempt)) return attempt;
    if ("error" in attempt) return { ok: false, kind: "transport", error: attempt.error };
    const res = attempt.res;
    // The route returns 400 with { error } for invalid TRQL.
    const data = (await res.json().catch(() => ({}))) as { results?: unknown; error?: string };
    if (!res.ok) {
      // 429 is the concurrency rejection and the rate limiter: nothing is wrong with the
      // query, so it is not a query error.
      if (res.status === 429) {
        return {
          ok: false,
          kind: "busy",
          error: `${data.error ?? "The query service is busy right now."} You can retry the same query shortly.`,
        };
      }
      return {
        ok: false,
        kind: res.status >= 500 ? "transport" : "query",
        error: data.error ?? `Query failed (status ${res.status}).`,
      };
    }
    return {
      ok: true,
      rows: Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [],
    };
  }

  // Skipped rather than blocking the render when there is no token or the request broke.
  async function validateChartQuery(
    query: string,
    period: string | undefined,
    target: EnvTarget | undefined
  ): Promise<string | null> {
    if (!target) return null;
    const result = await postQuery(query, period, target);
    if (isEnvUnavailable(result) || result.ok) return null;
    if (result.kind === "transport" || result.kind === "busy") {
      logger.warn("Skipped chart query validation", { error: result.error });
      return null;
    }
    return result.error;
  }

  return { origin, hasAuth, envApiGet, postQuery, validateChartQuery, environmentIdFor };
}
