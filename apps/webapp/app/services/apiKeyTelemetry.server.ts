import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

export type ApiKeyOperation = "create" | "prepare_policy" | "revoke";
export type ApiKeyOperationResult = "success" | "rejected" | "error";
export type ApiKeyOperationReason =
  | "none"
  | "database_error"
  | "not_found_or_revoked"
  | "policy_rejected"
  | "policy_error";

export type PublicTokenMintResult = "success" | "rejected" | "error";
export type PublicTokenMintReason =
  | "none"
  | "invalid_body"
  | "scope_not_allowed"
  | "invalid_expiration"
  | "expiration_not_future"
  | "expiration_too_long"
  | "signing_failed";

const telemetry = singleton("apiKeyTelemetry", () => {
  const meter = getMeter("api-key");

  return {
    operations: meter.createCounter("api_key.operations", {
      description: "Additional environment API key management operations",
    }),
    publicTokenMintAttempts: meter.createCounter("public_token.mint_attempts", {
      description: "Public access token mint attempts using environment API keys",
    }),
  };
});

export const apiKeyTelemetry = {
  recordOperation(
    operation: ApiKeyOperation,
    result: ApiKeyOperationResult,
    reason: ApiKeyOperationReason = "none"
  ) {
    telemetry.operations.add(1, { operation, result, reason });
  },
  recordPublicTokenMint(result: PublicTokenMintResult, reason: PublicTokenMintReason = "none") {
    telemetry.publicTokenMintAttempts.add(1, { result, reason });
  },
};

export type ApiKeyTelemetry = typeof apiKeyTelemetry;
