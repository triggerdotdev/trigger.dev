import type {
  WebhookVerifierArtifact as VerifierArtifact,
  WebhookVerifierConfig as VerifierConfig,
  WebhookVerifierResult as VerifierResult,
} from "@trigger.dev/core/v3";

export type VerifyInput = {
  rawBytes: Uint8Array;
  headers: Record<string, string>; // lower-cased keys, see gotcha
  url: string;
  secret: string; // plaintext signing secret, fail-closed upstream (never empty here)
  nowMs?: number; // injectable clock for deterministic timestamp-tolerance tests
};

export interface SchemeVerifier {
  readonly scheme: VerifierConfig["scheme"];
  verify(config: VerifierConfig, input: VerifyInput): VerifierResult;
}

export type { VerifierArtifact, VerifierConfig, VerifierResult };
