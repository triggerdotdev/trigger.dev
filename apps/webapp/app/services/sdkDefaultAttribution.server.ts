import type { ServerBuild } from "@remix-run/server-runtime";
import { parse as parseVersion } from "semver";
import { createKeyedAllowance, createRouteIdMatcher } from "./ingressBodyCap.server";

const DIAGNOSTICS_PER_MINUTE = 5;
const MAX_SDK_VERSION_LENGTH = 128;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function createSdkDefaultAttribution(
  routes: ServerBuild["routes"],
  now: () => number = Date.now
) {
  const routeIdFor = createRouteIdMatcher(routes);
  const allowance = createKeyedAllowance({ limit: DIAGNOSTICS_PER_MINUTE, windowMs: 60_000, now });

  return (request: Request) => {
    const attributes = {
      http_method: HTTP_METHODS.has(request.method) ? request.method : "OTHER",
      route: routeIdFor(new URL(request.url).pathname) ?? "unmatched",
    };
    // One process-wide budget, never keyed by caller-controlled headers or versions.
    const { allowed, heldBack } = allowance("default");
    return {
      attributes,
      diagnostic: allowed
        ? {
            ...attributes,
            sdk_version: sdkReleaseVersion(request.headers.get("trigger-version")),
            linesHeldBack: heldBack,
          }
        : undefined,
    };
  };
}

// Retain only the numeric release version. Prerelease/build suffixes can contain arbitrary
// caller-controlled text and are deliberately excluded from diagnostics and metric labels.
function sdkReleaseVersion(version: string | null): string {
  if (!version) return "missing";
  if (version.length > MAX_SDK_VERSION_LENGTH) return "invalid";
  const parsed = parseVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : "invalid";
}

let configuredRoutes: ServerBuild["routes"] | undefined;
let attribution = createSdkDefaultAttribution({});

export function configureSdkDefaultAttribution(routes: ServerBuild["routes"]) {
  if (configuredRoutes === routes) return;
  configuredRoutes = routes;
  attribution = createSdkDefaultAttribution(routes);
}

export function sdkDefaultAttribution(request: Request) {
  return attribution(request);
}
