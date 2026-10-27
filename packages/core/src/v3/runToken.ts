import { decodeJwt, decodeProtectedHeader } from "jose";
import { supportsRunToken } from "./runTokenOperations.js";
import { recordRunTokenSelection, type RunTokenSelectionReason } from "./runTokenTelemetry.js";
import { taskContext } from "./task-context-api.js";
import { getEnvVar } from "./utils/getEnv.js";

const RUN_TOKEN_TYPE = "run+jwt";
const RUN_TOKEN_AUDIENCE = "trigger:api";
const RUN_TOKEN_USE = "run";
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;
// Fall back before expiry so a token can't expire between selection and server verification.
const RUN_TOKEN_EXPIRY_BUFFER_SECONDS = 5 * 60;

/** Format classifier only. The server, not this helper, verifies the signature and authorizes use. */
export function isRunToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => JWT_SEGMENT.test(part))) return false;

  try {
    return decodeProtectedHeader(token).typ === RUN_TOKEN_TYPE;
  } catch {
    return false;
  }
}

function selectionReason(token: string): RunTokenSelectionReason {
  if (!isRunToken(token)) return "malformed_token";

  try {
    const claims = decodeJwt(token);
    if (
      claims.token_use !== RUN_TOKEN_USE ||
      claims.aud !== RUN_TOKEN_AUDIENCE ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      !Array.isArray(claims.scopes) ||
      !claims.scopes.every((scope) => typeof scope === "string")
    ) {
      return "malformed_token";
    }

    if (claims.exp <= Date.now() / 1_000 + RUN_TOKEN_EXPIRY_BUFFER_SECONDS) return "expired_token";
    if (!claims.scopes.includes("admin")) return "old_scope";
    return "selected";
  } catch {
    return "malformed_token";
  }
}

/**
 * Resolve an implicit SDK credential per request, including after warm starts and token rotation.
 * Explicit caller credentials must bypass this helper. This is not JWT verification, and an HTTP
 * authentication failure must never cause an automatic retry with the fallback credential.
 */
export function resolveRunTokenCredential(
  operation: string,
  fallback: string | undefined,
  recordSelection = true
): string | undefined {
  return resolveRunTokenCredentialSelection(operation, fallback, recordSelection).accessToken;
}

export function resolveRunTokenCredentialSelection(
  operation: string,
  fallback: string | undefined,
  recordSelection = true,
  branchOverride = false
): { accessToken: string | undefined; reason: RunTokenSelectionReason } {
  let reason: RunTokenSelectionReason;
  let token: string | undefined;

  if (!taskContext.isInsideTask) {
    reason = "outside_task";
  } else if (branchOverride) {
    reason = "branch_override";
  } else if (!supportsRunToken(operation)) {
    reason = "unsupported_operation";
  } else {
    token = getEnvVar("TRIGGER_RUN_TOKEN");
    reason = token ? selectionReason(token) : "missing_token";
  }

  const credential = reason === "selected" ? token : fallback;
  if (recordSelection) recordRunTokenSelection(operation, credential, reason);
  return { accessToken: credential, reason };
}
