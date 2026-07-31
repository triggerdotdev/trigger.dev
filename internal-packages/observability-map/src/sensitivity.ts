import type { EntryPoint } from "./types.js";
import { routePathOf } from "./adapters/remix.js";

const SENSITIVE_SYMBOLS = [
  "clearImpersonation",
  "setImpersonation",
  "requireAdminApiRequest",
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
  for (const seg of segments) {
    if (SENSITIVE_SEGMENTS.includes(seg)) reasons.push(`path segment "${seg}"`);
  }

  return { sensitive: reasons.length > 0, reasons };
}
