import { logger } from "@trigger.dev/sdk";

/**
 * The agent's HTTP surface: the delegated-token GET, the env-JWT exchange and its
 * turn-scoped cache, and the query POST both `run_query` and chart validation use.
 */

export type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

// "query" is the server rejecting the TRQL, "transport" is the request breaking. Chart
// validation only fails a render on "query".
export type QueryPostResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; kind: "query" | "transport"; error: string };

export const NO_AUTH = { error: "No delegated access is available for this turn." } as const;

export async function apiGet(origin: string, path: string, token: string): Promise<FetchResult> {
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

// The exchange ceilings these scopes to the delegated token's read-only cap, so the
// JWT can never widen the grant. Null when there is no current env, or on a denial.
async function exchangeEnvJwt(
  origin: string,
  userActorToken: string,
  projectRef: string,
  environmentName: string
): Promise<string | null> {
  const res = await fetch(`${origin}/api/v1/projects/${projectRef}/${environmentName}/jwt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userActorToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      claims: { scopes: ["read:runs", "read:deployments", "read:errors", "read:query"] },
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { token?: string };
  return data.token ?? null;
}

export type DashboardAgentApiClient = {
  /** The API origin with any trailing slash removed. Empty when none was injected. */
  origin: string;
  /** Whether this turn has both a delegated token and an origin to spend it on. */
  hasAuth: boolean;
  /** A GET as the environment JWT. `null` means there is no current environment. */
  envApiGet(path: string): Promise<FetchResult | null>;
  postQuery(query: string, period: string | undefined): Promise<QueryPostResult | null>;
  validateChartQuery(query: string, period: string | undefined): Promise<string | null>;
};

export type ApiClientContext = {
  userActorToken?: string;
  apiOrigin?: string;
  projectRef?: string;
  environmentName?: string;
};

export function createApiClient(ctx: ApiClientContext): DashboardAgentApiClient {
  const { userActorToken, apiOrigin, projectRef, environmentName } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // Turn-scoped, since the tool set is rebuilt per turn, and keyed by project +
  // environment. Caching the promise makes concurrent calls share one exchange.
  const envJwts = new Map<string, Promise<string | null>>();
  function getEnvJwt(refresh = false): Promise<string | null> {
    if (!hasAuth || !projectRef || !environmentName) return Promise.resolve(null);
    const key = `${projectRef}/${environmentName}`;
    if (refresh) envJwts.delete(key);
    let pending = envJwts.get(key);
    if (!pending) {
      pending = exchangeEnvJwt(origin, userActorToken!, projectRef, environmentName);
      envJwts.set(key, pending);
    }
    return pending;
  }

  /**
   * `null` means there is no current environment. On an unauthorized result the cache
   * entry is dropped and the call is retried once, since a token can be minted stale.
   */
  async function withEnvJwt<T>(
    call: (jwt: string) => Promise<T>,
    isUnauthorized: (result: T) => boolean
  ): Promise<T | null> {
    const jwt = await getEnvJwt();
    if (!jwt) return null;
    const first = await call(jwt);
    if (!isUnauthorized(first)) return first;
    const fresh = await getEnvJwt(true);
    if (!fresh) return first;
    return call(fresh);
  }

  const unauthorizedGet = (result: FetchResult) => !result.ok && result.status === 401;

  function envApiGet(path: string): Promise<FetchResult | null> {
    return withEnvJwt((jwt) => apiGet(origin, path, jwt), unauthorizedGet);
  }

  // A POST, so it can't use envApiGet, but keeps the same JWT cache and one-shot
  // re-exchange on a 401. Shared by run_query and chart-block validation.
  async function postQuery(
    query: string,
    period: string | undefined
  ): Promise<QueryPostResult | null> {
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
    if (!attempt) return null;
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
    if (!result || result.ok) return null;
    if (result.kind === "transport") {
      logger.warn("Skipped chart query validation", { error: result.error });
      return null;
    }
    return result.error;
  }

  return { origin, hasAuth, envApiGet, postQuery, validateChartQuery };
}
