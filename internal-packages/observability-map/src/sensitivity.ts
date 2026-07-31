import type { EntryPoint } from "./types.js";
import { routePathOf } from "./adapters/remix.js";

/**
 * Symbols whose presence says the route does something risky. Calling a guard is not one of them:
 * `requireAdminApiRequest` was on this list and made 34 of the 67 sensitive entry points sensitive
 * purely because they were guarded, which `auth-boundary` then passed them for. A mitigation
 * cannot be the hazard, and this list feeds the fix list's primary sort key.
 */
const SENSITIVE_SYMBOLS = [
  "clearImpersonation",
  "setImpersonation",
  "createPersonalAccessToken",
  "regenerateApiKey",
  "createJWT",
  "signJWT",
  "updateEnvVars",
  "createAuthorizationCode",
];

// Whole path segments only, so "authorship" does not match "auth".
const SENSITIVE_SEGMENTS = [
  "auth",
  "jwt",
  "token",
  "tokens",
  "envvars",
  "billing",
  "payment",
  "invoices",
  "secrets",
  "impersonate",
  "authorization-code",
  "regenerate-api-key",
];

export type Sensitivity = { sensitive: boolean; reasons: string[] };

export function classifySensitivity(ep: EntryPoint): Sensitivity {
  const reasons: string[] = [];

  // importedNames is file-wide; calleeNames is scoped to the loader/action body. A sensitive
  // symbol called only at module scope is caught here only if it is also imported.
  const symbols = new Set([...ep.importedNames, ...ep.calleeNames]);
  for (const s of SENSITIVE_SYMBOLS) {
    if (symbols.has(s)) reasons.push(`calls ${s}`);
  }

  // `routePathOf` turns both flat routes (`api.v1.envvars.ts`) and directory routes
  // (`billing/route.tsx`) into real `/`-separated path segments, so this matches whole segments in
  // either shape rather than splitting the raw fileName on ".".
  const segments = routePathOf(ep.fileName)
    .split("/")
    .filter((s) => s.length > 0);
  for (const [i, seg] of segments.entries()) {
    if (!SENSITIVE_SEGMENTS.includes(seg)) continue;
    // A waitpoint token is a handle for resuming a run, not a credential. Seven of the eight
    // `tokens` matches in the tree were waitpoint routes, so the segment on its own was mostly
    // finding the wrong thing.
    if ((seg === "token" || seg === "tokens") && segments[i - 1] === "waitpoints") continue;
    reasons.push(`path segment "${seg}"`);
  }

  return { sensitive: reasons.length > 0, reasons };
}
