import type { WebhookAsymmetricConfig as AsymmetricConfig } from "@trigger.dev/core/v3";
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { deriveIdempotencyKey, parseEventBody } from "./derive.js";
import { prepareSignedVerification } from "./parse.js";
import type { SchemeVerifier, VerifierResult, VerifyInput } from "./types.js";
import { decodeSignature } from "./util.js";

// SPKI DER prefix for an Ed25519 public key (RFC 8410): 12-byte header + 32 raw key bytes.
// Lets us accept a raw Ed25519 key (e.g. Discord's hex public key) without a PEM wrapper.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Ed25519 is PureEdDSA (no prehash) → algorithm null; the others name the digest Node signs with.
const NODE_ALGORITHM: Record<AsymmetricConfig["algorithm"], string | null> = {
  ed25519: null,
  "ecdsa-p256": "sha256",
  "ecdsa-p384": "sha384",
  "rsa-sha256": "sha256",
};

// ECDSA signatures arrive either DER-encoded or as raw r||s (IEEE P1363); accept both.
const DSA_ENCODINGS = ["der", "ieee-p1363"] as const;

function importPublicKey(
  stored: string,
  encoding: AsymmetricConfig["publicKeyEncoding"],
  algorithm: AsymmetricConfig["algorithm"]
): KeyObject {
  const enc = encoding ?? "pem";
  if (enc === "pem") return createPublicKey(stored);
  if (enc === "spki-der-base64") {
    return createPublicKey({ key: Buffer.from(stored, "base64"), format: "der", type: "spki" });
  }
  // Raw key bytes. Only Ed25519 has a fixed-size raw key we can wrap into SPKI here.
  const raw = Buffer.from(stored, enc === "raw-hex" ? "hex" : "base64");
  if (algorithm === "ed25519") {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  }
  throw new Error("raw public key encoding is only supported for ed25519");
}

export const asymmetricVerifier: SchemeVerifier = {
  scheme: "asymmetric",
  verify(config, input): VerifierResult {
    const cfg = config as AsymmetricConfig;

    const prep = prepareSignedVerification(cfg, input);
    if (!prep.ok) return fail(prep.error, cfg, input);

    let key: KeyObject;
    try {
      key = importPublicKey(input.secret, cfg.publicKeyEncoding, cfg.algorithm);
    } catch {
      return fail("invalid public key", cfg, input);
    }

    const nodeAlgorithm = NODE_ALGORITHM[cfg.algorithm];
    const message = cfg.prehash
      ? createHash(cfg.prehash).update(prep.signingBytes).digest()
      : prep.signingBytes;
    const isEcdsa = cfg.algorithm === "ecdsa-p256" || cfg.algorithm === "ecdsa-p384";
    const keys = isEcdsa ? DSA_ENCODINGS.map((dsaEncoding) => ({ key, dsaEncoding })) : [key];

    const matched = prep.signatures.some((sig) => {
      const signature = decodeSignature(sig, cfg.encoding);
      return keys.some((k) => {
        try {
          return cryptoVerify(nodeAlgorithm, message, k, signature);
        } catch {
          return false;
        }
      });
    });
    if (!matched) return fail("signature mismatch", cfg, input);

    const idempotencyKey = deriveIdempotencyKey({
      idempotencyField: cfg.idempotencyField,
      headers: input.headers,
      rawBytes: input.rawBytes,
      timestampValue: prep.timestampValue,
      signatureValue: prep.signatureValue,
    });
    return {
      ok: true,
      idempotencyKey,
      ...parseEventBody(input.rawBytes, { headers: input.headers }),
    };
  },
};

function fail(error: string, cfg: AsymmetricConfig, input: VerifyInput): VerifierResult {
  return {
    ok: false,
    error,
    idempotencyKey: deriveIdempotencyKey({
      idempotencyField: cfg.idempotencyField,
      headers: input.headers,
      rawBytes: input.rawBytes,
      timestampValue: "",
      signatureValue: "",
    }),
  };
}
