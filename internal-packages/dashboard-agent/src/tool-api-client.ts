import { logger } from "@trigger.dev/sdk";
import { DASHBOARD_AGENT_ENV_JWT_SCOPES } from "./tool-schemas.js";

/**
 * The agent's HTTP surface: the delegated-token GET, the env-JWT exchange and its
 * turn-scoped cache, and the query POST both `run_query` and chart validation use.
 */

export type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

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

// "query" is the server rejecting the TRQL, "transport" is the request breaking. Chart
// validation only fails a render on "query".
export type QueryPostResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; kind: "query" | "transport"; error: string };

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
  const res = await fetch(`${origin}${path}`, { headers });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

// The exchange ceilings these scopes to the delegated token's read-only cap, so the
// JWT can never widen the grant.
async function exchangeEnvJwt(
  origin: string,
  userActorToken: string,
  projectRef: string,
  environmentName: string,
  branch?: string
): Promise<{ ok: true; token: string } | EnvUnavailable> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${userActorToken}`,
    "Content-Type": "application/json",
  };
  if (branch) headers["x-trigger-branch"] = branch;
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v1/projects/${projectRef}/${environmentName}/jwt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ claims: { scopes: [...DASHBOARD_AGENT_ENV_JWT_SCOPES] } }),
    });
  } catch {
    return { ok: false, envUnavailable: "unknown" };
  }
  if (!res.ok) return { ok: false, envUnavailable: "unknown", status: res.status };
  const data = (await res.json().catch(() => ({}))) as { token?: string };
  if (!data.token) return { ok: false, envUnavailable: "unknown" };
  return { ok: true, token: data.token };
}

export type DashboardAgentApiClient = {
  /** The API origin with any trailing slash removed. Empty when none was injected. */
  origin: string;
  /** Whether this turn has both a delegated token and an origin to spend it on. */
  hasAuth: boolean;
  /** A GET as the environment JWT, or why no environment JWT could be made. */
  envApiGet(path: string): Promise<EnvFetchResult>;
  postQuery(query: string, period: string | undefined): Promise<QueryPostResult | EnvUnavailable>;
  validateChartQuery(query: string, period: string | undefined): Promise<string | null>;
};

export type ApiClientContext = {
  userActorToken?: string;
  apiOrigin?: string;
  projectRef?: string;
  environmentName?: string;
  environmentBranch?: string;
};

export function createApiClient(ctx: ApiClientContext): DashboardAgentApiClient {
  const { userActorToken, apiOrigin, projectRef, environmentName, environmentBranch } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // Turn-scoped, since the tool set is rebuilt per turn, and keyed by project +
  // environment. Caching the promise makes concurrent calls share one exchange.
  type EnvJwt = { ok: true; token: string } | EnvUnavailable;
  const envJwts = new Map<string, Promise<EnvJwt>>();
  function getEnvJwt(refresh = false): Promise<EnvJwt> {
    if (!hasAuth || !projectRef || !environmentName) return Promise.resolve(MISSING_ENV);
    const key = `${projectRef}/${environmentName}/${environmentBranch ?? ""}`;
    if (refresh) envJwts.delete(key);
    let pending = envJwts.get(key);
    if (!pending) {
      // A failed exchange is not cached: a 403 or a 5xx would otherwise pin the whole turn.
      pending = exchangeEnvJwt(
        origin,
        userActorToken!,
        projectRef,
        environmentName,
        environmentBranch
      ).then((result) => {
        if (!result.ok) envJwts.delete(key);
        return result;
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
    call: (jwt: string) => Promise<T>,
    isUnauthorized: (result: T) => boolean
  ): Promise<T | EnvUnavailable> {
    const jwt = await getEnvJwt();
    if (!jwt.ok) return jwt;
    const first = await call(jwt.token);
    if (!isUnauthorized(first)) return first;
    const fresh = await getEnvJwt(true);
    if (!fresh.ok) return first;
    return call(fresh.token);
  }

  const unauthorizedGet = (result: FetchResult) => !result.ok && result.status === 401;

  function envApiGet(path: string): Promise<EnvFetchResult> {
    return withEnvJwt((jwt) => apiGet(origin, path, jwt), unauthorizedGet);
  }

  // A POST, so it can't use envApiGet, but keeps the same JWT cache and one-shot
  // re-exchange on a 401. Shared by run_query and chart-block validation.
  async function postQuery(
    query: string,
    period: string | undefined
  ): Promise<QueryPostResult | EnvUnavailable> {
    const attempt = await withEnvJwt<{ res: Response } | { error: string }>(
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
    period: string | undefined
  ): Promise<string | null> {
    const result = await postQuery(query, period);
    if (isEnvUnavailable(result) || result.ok) return null;
    if (result.kind === "transport") {
      logger.warn("Skipped chart query validation", { error: result.error });
      return null;
    }
    return result.error;
  }

  return { origin, hasAuth, envApiGet, postQuery, validateChartQuery };
}
