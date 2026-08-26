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
  | { ok: false; status: number }
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
  if (!res.ok) return { ok: false, status: res.status };
  try {
    return { ok: true, data: await res.json() };
  } catch (error) {
    return { ok: false, transport: (error as Error).message };
  }
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
      signal: AbortSignal.timeout(JWT_TIMEOUT_MS),
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
  envApiGet(path: string, target?: ApiTarget): Promise<EnvFetchResult>;
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

// A per-call override of which project/environment a data lookup targets, for reads
// that cross into another project of the same organization. Omitted fields fall back
// to the context's own project/environment.
export type ApiTarget = { projectRef?: string; environmentName?: string };

export function createApiClient(ctx: ApiClientContext): DashboardAgentApiClient {
  const { userActorToken, apiOrigin, projectRef, environmentName, environmentBranch } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // Turn-scoped, since the tool set is rebuilt per turn, and keyed by project +
  // environment. Caching the promise makes concurrent calls share one exchange.
  type EnvJwt = { ok: true; token: string } | EnvUnavailable;
  const envJwts = new Map<string, Promise<EnvJwt>>();
  function getEnvJwt(refresh = false, target?: ApiTarget): Promise<EnvJwt> {
    // An override drops the branch: it names another project/environment, which the
    // current branch can't be assumed to apply to. A field left off the override still
    // falls back to ctx's own value.
    const ref = target?.projectRef ?? projectRef;
    const env = target?.environmentName ?? environmentName;
    const branch = target ? undefined : environmentBranch;
    if (!hasAuth || !ref || !env) return Promise.resolve(MISSING_ENV);
    const key = `${ref}/${env}/${branch ?? ""}`;
    if (refresh) envJwts.delete(key);
    let pending = envJwts.get(key);
    if (!pending) {
      // A failed exchange is not cached: a 403 or a 5xx would otherwise pin the whole turn.
      pending = exchangeEnvJwt(origin, userActorToken!, ref, env, branch).then((result) => {
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
    isUnauthorized: (result: T) => boolean,
    target?: ApiTarget
  ): Promise<T | EnvUnavailable> {
    const jwt = await getEnvJwt(false, target);
    if (!jwt.ok) return jwt;
    const first = await call(jwt.token);
    if (!isUnauthorized(first)) return first;
    const fresh = await getEnvJwt(true, target);
    if (!fresh.ok) return first;
    return call(fresh.token);
  }

  const unauthorizedGet = (result: FetchResult) =>
    !result.ok && "status" in result && result.status === 401;

  function envApiGet(path: string, target?: ApiTarget): Promise<EnvFetchResult> {
    return withEnvJwt((jwt) => apiGet(origin, path, jwt), unauthorizedGet, target);
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
    period: string | undefined
  ): Promise<string | null> {
    const result = await postQuery(query, period);
    if (isEnvUnavailable(result) || result.ok) return null;
    if (result.kind === "transport" || result.kind === "busy") {
      logger.warn("Skipped chart query validation", { error: result.error });
      return null;
    }
    return result.error;
  }

  return { origin, hasAuth, envApiGet, postQuery, validateChartQuery };
}
