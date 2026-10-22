import type {
  SchemeVerifier,
  VerifierArtifact,
  VerifierConfig,
  VerifierResult,
  VerifyInput,
} from "./types.js";
import { hmacVerifier } from "./hmac.js";
import { asymmetricVerifier } from "./asymmetric.js";
import { sharedSecretVerifier } from "./sharedSecret.js";
import { urlSecretVerifier } from "./urlSecret.js";

const SCHEME_REGISTRY: Record<VerifierConfig["scheme"], SchemeVerifier> = {
  hmac: hmacVerifier,
  "shared-secret": sharedSecretVerifier,
  "url-secret": urlSecretVerifier,
  asymmetric: asymmetricVerifier,
};

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

export function verify(artifact: VerifierArtifact, input: VerifyInput): VerifierResult {
  const normalized: VerifyInput = { ...input, headers: normalizeHeaders(input.headers) };

  switch (artifact.kind) {
    case "config":
    case "preset": {
      const config = artifact.config;
      const verifier = SCHEME_REGISTRY[config.scheme];
      if (!verifier) {
        throw new Error(`No verifier registered for scheme "${config.scheme}"`);
      }
      return verifier.verify(config, normalized);
    }
    case "bundle":
      throw new Error("Bundle verifiers are not available in this version (P3 seam)");
    default: {
      const _exhaustive: never = artifact;
      throw new Error(`Unknown verifier artifact kind`);
    }
  }
}

/**
 * Verifies against each signing secret in order (the current one first, then a previous secret
 * still inside its rotation grace window) and returns the first passing verdict, or the current
 * secret's failure. `secretIndex` is the position of the secret that matched.
 */
export function verifyWithSecrets(
  artifact: VerifierArtifact,
  input: Omit<VerifyInput, "secret">,
  secrets: readonly [string, ...string[]]
): VerifierResult & { secretIndex?: number } {
  const [current, ...previous] = secrets;
  const first = verify(artifact, { ...input, secret: current });
  if (first.ok) return { ...first, secretIndex: 0 };
  for (const [index, secret] of previous.entries()) {
    const result = verify(artifact, { ...input, secret });
    if (result.ok) return { ...result, secretIndex: index + 1 };
  }
  return first;
}

export { type VerifyInput, type VerifierResult } from "./types.js";
