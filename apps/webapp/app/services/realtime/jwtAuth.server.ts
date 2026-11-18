import {
  extractJWTSub,
  isPublicJWT,
  validateJWT,
  type ValidationResult,
} from "@trigger.dev/core/v3/jwt";
import {
  resolveJwtSigningKey,
  resolvePublicTokenSubject,
  sourcePersonalAccessTokenCheck,
  sourcePersonalAccessTokenClaim,
} from "@trigger.dev/rbac";
import { $replica } from "~/db.server";
import { hashApiKey } from "~/utils/apiKeys";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import {
  publicTokenSubjects,
  sourcePersonalAccessTokens,
} from "~/services/publicTokenSubject.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

type ValidatePublicJwtKeySuccess = {
  ok: true;
  environment: AuthenticatedEnvironment;
  claims: Record<string, unknown>;
  /** Last 4 characters of the root key that verified the token, for attribution. */
  signingKeyLast4: string;
  /** SHA-256 hex of that key, computed on demand, for attribution. */
  signingKeyHash: () => string;
};

type ValidatePublicJwtKeyError = {
  ok: false;
  error: string;
};

export type ValidatePublicJwtKeyResult = ValidatePublicJwtKeySuccess | ValidatePublicJwtKeyError;

export async function validatePublicJwtKey(token: string): Promise<ValidatePublicJwtKeyResult> {
  // Get the sub claim from the token
  // Use the sub claim to find the environment
  // Validate the token against the environment.apiKey
  // Once that's done, return the environment and the claims
  const sub = extractJWTSub(token);

  if (!sub) {
    return { ok: false, error: "Invalid Public Access Token, missing subject." };
  }

  const subject = resolvePublicTokenSubject(sub, publicTokenSubjects);

  if (!subject) {
    return { ok: false, error: "Invalid Public Access Token, environment not found." };
  }

  const environment = await findEnvironmentById(subject.environmentId);

  if (!environment) {
    return { ok: false, error: "Invalid Public Access Token, environment not found." };
  }

  // A disabled root key does not invalidate public JWTs: disabling rotates
  // the stored apiKey (killing tokens signed with the old value), and the
  // rotated value keeps signing server-issued tokens so Realtime still works.
  let signingKey = resolveJwtSigningKey(environment);
  let result = await validateJWT(token, signingKey);

  // PATs are signed with the env's apiKey at mint time. If the env's apiKey
  // has since been rotated, signature verification fails against the current
  // key — fall back to any RevokedApiKey rows still in their grace window.
  // Only run this query on the failure path so the success path is unchanged.
  if (!result.ok) {
    const fallback = await validateAgainstRevokedApiKeys(
      token,
      environment.parentEnvironment?.id ?? environment.id
    );
    if (fallback) {
      result = fallback.result;
      signingKey = fallback.signingKey;
    }
  }

  if (!result.ok) {
    switch (result.code) {
      case "ERR_JWT_EXPIRED": {
        return {
          ok: false,
          error:
            "Public Access Token has expired. See https://trigger.dev/docs/frontend/overview#authentication for more information.",
        };
      }
      case "ERR_JWT_CLAIM_INVALID": {
        return {
          ok: false,
          error: `Public Access Token is invalid: ${result.error}. See https://trigger.dev/docs/frontend/overview#authentication for more information.`,
        };
      }
      default: {
        return {
          ok: false,
          error:
            "Public Access Token is invalid. See https://trigger.dev/docs/frontend/overview#authentication for more information.",
        };
      }
    }
  }

  // A JWT from the PAT/UAT exchange also names its source PAT, and dies with it.
  const sourcePat = sourcePersonalAccessTokenClaim(result.payload, sourcePersonalAccessTokens);
  if (
    sourcePat &&
    !(sourcePat.id && (await sourcePersonalAccessTokenCheck.isActive($replica, sourcePat.id)))
  ) {
    return {
      ok: false,
      error:
        "Public Access Token is invalid. See https://trigger.dev/docs/frontend/overview#authentication for more information.",
    };
  }

  return {
    ok: true,
    environment,
    claims: result.payload,
    signingKeyLast4: signingKey.slice(-4),
    signingKeyHash: () => hashApiKey(signingKey),
  };
}

async function validateAgainstRevokedApiKeys(
  token: string,
  signingEnvironmentId: string
): Promise<{ result: ValidationResult; signingKey: string } | undefined> {
  const revokedApiKeys = await $replica.revokedApiKey.findMany({
    where: {
      runtimeEnvironmentId: signingEnvironmentId,
      expiresAt: { gt: new Date() },
    },
    select: { apiKey: true },
  });

  for (const { apiKey } of revokedApiKeys) {
    const fallbackResult = await validateJWT(token, apiKey);
    if (fallbackResult.ok) {
      return { result: fallbackResult, signingKey: apiKey };
    }
  }

  return undefined;
}

export { isPublicJWT };

export function extractJwtSigningSecretKey(environment: AuthenticatedEnvironment) {
  return resolveJwtSigningKey(environment);
}
