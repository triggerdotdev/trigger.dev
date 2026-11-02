import { getMeter } from "@internal/tracing";
import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import {
  isSdkCredentialTelemetryOperation,
  isSdkCredentialTelemetryReason,
  SDK_CREDENTIAL_OPERATION_HEADER,
  SDK_CREDENTIAL_REASON_HEADER,
} from "@trigger.dev/core/v3";
import { isPublicJWT } from "@trigger.dev/core/v3/jwt";
import { isDefaultDevBranch, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import type { BearerAuthOptions, BearerAuthResult } from "@trigger.dev/plugins";
import type {
  BearerCredentialKind,
  BearerLookupPath,
  BearerResolution,
  HostBearerAuthResult,
  RbacResource,
  RoleBaseAccessController,
} from "@trigger.dev/rbac";
import { authenticateRunToken } from "~/services/oidc/runTokenAuth.server";
import { isRunTokenFormat } from "~/services/oidc/runTokenVerify";
import { rbac } from "~/services/rbac.server";
import { singleton } from "~/utils/singleton";

type ApiAuthResult = "success" | "invalid" | "forbidden" | "error";

const telemetry = singleton("apiAuthTelemetry", () => {
  const meter = getMeter("api-auth");
  const attempts = meter.createCounter("api_auth.attempts", {
    description: "Completed environment bearer authentication attempts",
  });
  const duration = meter.createHistogram("api_auth.duration_ms", {
    description: "Environment bearer authentication duration",
    unit: "ms",
  });

  const sdkCredentialSelections = meter.createCounter("api_auth.sdk_credential_selections", {
    description: "SDK credential selections reported on API authentication attempts",
  });

  return { attempts, duration, sdkCredentialSelections };
});

export async function authenticateBearerWithTelemetry(
  request: Request,
  options: BearerAuthOptions,
  controller: Pick<RoleBaseAccessController, "authenticateBearer"> = rbac
): Promise<HostBearerAuthResult> {
  const startedAt = performance.now();
  const classified = classifyCredential(request, options.allowJWT ?? false);
  let final = { ...classified, result: "error" as ApiAuthResult };

  try {
    const result: BearerAuthResult & { resolution?: BearerResolution } =
      classified.credentialKind === "run_token"
        ? await authenticateRunTokenBearer(request)
        : await controller.authenticateBearer(request, options);
    // The host LazyController always attaches `resolution`; fall back to the
    // format-based classification if a caller (e.g. a test double) omits it.
    const resolution = result.resolution ?? classified;
    final = {
      credentialKind: resolution.credentialKind,
      lookupPath: resolution.lookupPath,
      result: result.ok ? "success" : result.status === 403 ? "forbidden" : "invalid",
    };
    recordAuthAttempt("rbac", final.credentialKind, final.lookupPath, final.result);
    return { ...result, resolution };
  } catch (error) {
    recordAuthAttempt("rbac", final.credentialKind, final.lookupPath, final.result);
    throw error;
  } finally {
    recordSdkCredentialSelection(request, final.credentialKind);
    telemetry.duration.record(performance.now() - startedAt, {
      resolver: "rbac",
      credential_kind: final.credentialKind,
      result: final.result,
      lookup_path: final.lookupPath,
    });
  }
}

const RUN_TOKEN_RESOLUTION = { credentialKind: "run_token", lookupPath: "run_token" } as const;

// Run tokens are host-owned and verified locally, so they never reach the RBAC controller.
async function authenticateRunTokenBearer(request: Request): Promise<HostBearerAuthResult> {
  const result = await authenticateRunToken(bearerToken(request) ?? "");
  if (!result.ok) {
    return { ...result, resolution: RUN_TOKEN_RESOLUTION };
  }

  const rawBranch = request.headers.get("x-trigger-branch");
  const branch = sanitizeBranchName(rawBranch);
  const environment = result.environment;
  const requestedBranch =
    environment.type === "DEVELOPMENT" && isDefaultDevBranch(branch) ? null : branch;
  if (
    (environment.type === "PREVIEW" || environment.type === "DEVELOPMENT") &&
    rawBranch &&
    (branch === null || requestedBranch !== environment.branchName)
  ) {
    return {
      ok: false,
      status: 401,
      error: "x-trigger-branch does not match the run token environment",
      resolution: RUN_TOKEN_RESOLUTION,
    };
  }

  return {
    ok: true,
    environment: result.environment,
    subject: {
      type: "runToken",
      runId: result.claims.run_id,
      environmentId: result.environment.id,
      organizationId: result.environment.organizationId,
      projectId: result.environment.projectId,
    },
    ability: result.ability,
    resolution: RUN_TOKEN_RESOLUTION,
  };
}

function bearerToken(request: Request): string | undefined {
  return request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
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
  let result: ApiAuthResult = "error";

  try {
    const value = await operation();
    result = value?.ok ? "success" : "invalid";
    recordAuthAttempt("legacy", classified.credentialKind, classified.lookupPath, result);
    return value;
  } catch (error) {
    recordAuthAttempt("legacy", classified.credentialKind, classified.lookupPath, result);
    throw error;
  } finally {
    recordSdkCredentialSelection(request, classified.credentialKind);
    telemetry.duration.record(performance.now() - startedAt, {
      resolver: "legacy",
      credential_kind: classified.credentialKind,
      result,
      lookup_path: classified.lookupPath,
    });
  }
}

const sdkTelemetryRecorded = new WeakSet<Request>();

function recordSdkCredentialSelection(request: Request, credentialKind: BearerCredentialKind) {
  if (sdkTelemetryRecorded.has(request)) return;
  const operation = request.headers.get(SDK_CREDENTIAL_OPERATION_HEADER);
  const reason = request.headers.get(SDK_CREDENTIAL_REASON_HEADER);
  if (!isSdkCredentialTelemetryOperation(operation) || !isSdkCredentialTelemetryReason(reason))
    return;

  sdkTelemetryRecorded.add(request);
  telemetry.sdkCredentialSelections.add(1, {
    operation,
    reason,
    credential_kind: credentialKind,
  });
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
  const token = bearerToken(request);
  if (!token) return { credentialKind: "unknown", lookupPath: "not_found" };
  if (isRunTokenFormat(token)) return RUN_TOKEN_RESOLUTION;
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
