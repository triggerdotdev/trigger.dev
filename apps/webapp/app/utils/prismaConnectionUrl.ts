export type PrismaConnectionParams = {
  connectionLimit: string;
  poolTimeout: string;
  connectTimeout: string;
  applicationName: string;
  /** `max_connection_lifetime` (seconds); omitted from the URL when undefined. */
  maxConnectionLifetime?: string;
};

export function buildPrismaConnectionUrl(
  baseUrl: string | URL,
  params: PrismaConnectionParams
): URL {
  const url = new URL(baseUrl);
  url.searchParams.set("connection_limit", params.connectionLimit);
  url.searchParams.set("pool_timeout", params.poolTimeout);
  url.searchParams.set("connect_timeout", params.connectTimeout);
  url.searchParams.set("application_name", params.applicationName);
  // Omit iff undefined, so an unconfigured deployment gets a byte-identical DSN.
  // Setting it unconditionally would write the string "undefined" into the URL.
  if (params.maxConnectionLifetime !== undefined) {
    url.searchParams.set("max_connection_lifetime", params.maxConnectionLifetime);
  }
  return url;
}

/**
 * Per-pool connection lifetime in seconds, or undefined for "leave it uncapped".
 * Subtracts 0-20% jitter, drawn once per pool, so pools built in one go do not
 * expire their connections in lockstep. Jitter only ever shortens the lifetime:
 * `base` is a maximum, and an operator may set it just under an upstream cutoff.
 * Pure (base and randomness injected) so it is testable without env.
 */
export function resolveConnectionLifetimeSeconds(
  base: number | undefined,
  random: () => number = Math.random
): number | undefined {
  if (base === undefined || !Number.isFinite(base) || base <= 0) {
    return undefined;
  }

  const rand = random();
  const r = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0;
  return Math.max(1, Math.round(base - r * base * 0.2));
}

/**
 * Pool options carrying the lifetime, or an empty object when uncapped. Omitting
 * the key keeps an unconfigured deployment off pg-pool's `|| 0` coercion path.
 */
export function connectionLifetimePoolOptions(lifetimeSeconds: number | undefined): {
  maxLifetimeSeconds?: number;
} {
  return lifetimeSeconds === undefined ? {} : { maxLifetimeSeconds: lifetimeSeconds };
}
