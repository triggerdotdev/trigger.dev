import { getMeter } from "@internal/tracing";
import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import { isPublicJWT } from "@trigger.dev/core/v3/jwt";
import type { BearerAuthOptions } from "@trigger.dev/plugins";
import type {
  BearerCredentialKind,
  BearerLookupPath,
  HostBearerAuthResult,
  RbacResource,
} from "@trigger.dev/rbac";
import { authFeatureControls } from "~/services/authFeatureControls.server";
import { rbac } from "~/services/rbac.server";
import { singleton } from "~/utils/singleton";

type ApiAuthResult = "success" | "invalid" | "forbidden" | "disabled" | "error";

const telemetry = singleton("apiAuthTelemetry", () => {
  const meter = getMeter("api-auth");
  const attempts = meter.createCounter("api_auth.attempts", {
    description: "Completed environment bearer authentication attempts",
  });
  const duration = meter.createHistogram("api_auth.duration_ms", {
    description: "Environment bearer authentication duration",
    unit: "ms",
  });

  meter
    .createObservableGauge("api_auth.rollout_mode", {
      description: "Active API authentication rollout modes",
    })
    .addCallback((result) => {
      result.observe(1, {
        control: "additional_key_lookup",
        mode: authFeatureControls.additionalApiKeyLookupEnabled() ? "enabled" : "disabled",
      });
    });

  return { attempts, duration };
});

export async function authenticateBearerWithTelemetry(
  request: Request,
  options: BearerAuthOptions
): Promise<HostBearerAuthResult> {
  const startedAt = performance.now();
  const classified = classifyCredential(request, options.allowJWT ?? false);
  let final = { ...classified, result: "error" as ApiAuthResult };

  try {
    const result = await rbac.authenticateBearer(request, options);
    // The host LazyController always attaches `resolution`; fall back to the
    // format-based classification if a caller (e.g. a test double) omits it.
    const resolution = result.resolution ?? classified;
    final = {
      credentialKind: resolution.credentialKind,
      lookupPath: resolution.lookupPath,
      result: result.ok
        ? "success"
        : resolution.lookupPath === "additional_skipped"
          ? "disabled"
          : result.status === 403
            ? "forbidden"
            : "invalid",
    };
    recordAuthAttempt("rbac", final.credentialKind, final.lookupPath, final.result);
    return result;
  } catch (error) {
    recordAuthAttempt("rbac", final.credentialKind, final.lookupPath, final.result);
    throw error;
  } finally {
    telemetry.duration.record(performance.now() - startedAt, {
      resolver: "rbac",
      credential_kind: final.credentialKind,
      result: final.result,
      lookup_path: final.lookupPath,
    });
  }
}

export async function authenticateAuthorizeBearerWithTelemetry(
  request: Request,
  check: { action: string; resource: RbacResource },
  options: BearerAuthOptions
) {
  // Keep authentication telemetry consistent with apiBuilder: a valid
  // credential records a successful authentication even when the subsequent
  // resource authorization fails. Authorization correctness is covered by the
  // route tests rather than folded into the authentication-health metric.
  const result = await authenticateBearerWithTelemetry(request, options);
  if (!result.ok) return result;

  if (!result.ability.can(check.action, check.resource)) {
    return { ok: false as const, status: 403 as const, error: "Unauthorized" };
  }

  return result;
}

export async function observeLegacyBearerAuthentication<T extends { ok: boolean } | undefined>(
  request: Request,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  const classified = classifyCredential(request, true);
  const lookupPath: BearerLookupPath =
    classified.credentialKind === "additional_api_key" &&
    !authFeatureControls.additionalApiKeyLookupEnabled()
      ? "additional_skipped"
      : classified.lookupPath;
  let result: ApiAuthResult = "error";

  try {
    const value = await operation();
    result = value?.ok ? "success" : lookupPath === "additional_skipped" ? "disabled" : "invalid";
    recordAuthAttempt("legacy", classified.credentialKind, lookupPath, result);
    return value;
  } catch (error) {
    recordAuthAttempt("legacy", classified.credentialKind, lookupPath, result);
    throw error;
  } finally {
    telemetry.duration.record(performance.now() - startedAt, {
      resolver: "legacy",
      credential_kind: classified.credentialKind,
      result,
      lookup_path: lookupPath,
    });
  }
}

function recordAuthAttempt(
  resolver: "rbac" | "legacy",
  credentialKind: BearerCredentialKind,
  lookupPath: BearerLookupPath,
  result: ApiAuthResult
) {
  telemetry.attempts.add(1, {
    resolver,
    credential_kind: credentialKind,
    result,
    lookup_path: lookupPath,
  });
}

// Best-effort pre-classification from the raw token format. This is only used
// for the metric attributes when the resolver throws before returning a
// resolution; the resolver's own resolution is authoritative on success/failure.
// Never records the credential itself — only its bounded format class.
function classifyCredential(
  request: Request,
  allowJWT: boolean
): { credentialKind: BearerCredentialKind; lookupPath: BearerLookupPath } {
  const token = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
  if (!token) return { credentialKind: "unknown", lookupPath: "not_found" };
  if (token.startsWith("pk_")) {
    return { credentialKind: "legacy_public_key", lookupPath: "legacy_public" };
  }
  if (allowJWT && isPublicJWT(token)) {
    return { credentialKind: "public_jwt", lookupPath: "jwt_current" };
  }
  if (isAdditionalApiKey(token)) {
    return { credentialKind: "additional_api_key", lookupPath: "additional" };
  }
  return token.startsWith("tr_")
    ? { credentialKind: "root_api_key", lookupPath: "root_current" }
    : { credentialKind: "unknown", lookupPath: "not_found" };
}
