import type { WebhookHmacConfig as HmacConfig } from "@trigger.dev/core/v3";
import type { SchemeVerifier, VerifierResult, VerifyInput } from "./types.js";
import { hmacDigest, deriveHmacKey, constantTimeEqual } from "./util.js";
import { deriveIdempotencyKey, parseEventBody } from "./derive.js";
import { prepareSignedVerification } from "./parse.js";

export const hmacVerifier: SchemeVerifier = {
  scheme: "hmac",
  verify(config, input): VerifierResult {
    const cfg = config as HmacConfig;

    // Shared, config-driven parsing: extract signature candidate(s) from the header
    // (Stripe `t=,v1=`, GitHub `sha256=`, Svix `v1,<b64>` lists, …), validate the timestamp,
    // and build the exact signed bytes. No per-provider code beyond this.
    const prep = prepareSignedVerification(cfg, input);
    if (!prep.ok) return fail(prep.error, cfg, input);

    const key = deriveHmacKey(input.secret, cfg.secret);
    const expected = hmacDigest(cfg.algorithm, key, prep.signingBytes, cfg.encoding);

    // Accept if ANY extracted candidate matches (signature rotation / multi-sig lists).
    const matched = prep.signatures.some((sig) => constantTimeEqual(sig, expected));
    if (!matched) return fail("signature mismatch", cfg, input);

    const idempotencyKey = deriveIdempotencyKey({
      idempotencyField: cfg.idempotencyField,
      headers: input.headers,
      rawBytes: input.rawBytes,
      timestampValue: prep.timestampValue,
      signatureValue: prep.signatureValue,
      formPayloadField: cfg.formPayload?.field,
    });
    return {
      ok: true,
      idempotencyKey,
      ...parseEventBody(input.rawBytes, { formPayloadField: cfg.formPayload?.field }),
    };
  },
};

function fail(error: string, cfg: HmacConfig, input: VerifyInput): VerifierResult {
  return {
    ok: false,
    error,
    idempotencyKey: deriveIdempotencyKey({
      idempotencyField: cfg.idempotencyField,
      headers: input.headers,
      rawBytes: input.rawBytes,
      timestampValue: "",
      signatureValue: "",
      formPayloadField: cfg.formPayload?.field,
    }),
  };
}
