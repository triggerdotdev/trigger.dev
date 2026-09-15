import type { WebhookSharedSecretConfig as SharedSecretConfig } from "@trigger.dev/core/v3";
import type { SchemeVerifier, VerifierResult, VerifyInput } from "./types.js";
import { constantTimeEqual } from "./util.js";
import { deriveIdempotencyKey, tryParseJson } from "./derive.js";

export const sharedSecretVerifier: SchemeVerifier = {
  scheme: "shared-secret",
  verify(config, input): VerifierResult {
    const cfg = config as Extract<SharedSecretConfig, { scheme: "shared-secret" }>;
    const provided = extractCandidate(cfg, input);
    if (provided === undefined) return failSS("missing shared secret", cfg, input);
    if (!constantTimeEqual(provided, input.secret))
      return failSS("shared secret mismatch", cfg, input);
    const idempotencyKey = deriveIdempotencyKey({
      idempotencyField: cfg.idempotencyField,
      headers: input.headers,
      rawBytes: input.rawBytes,
      timestampValue: "",
      signatureValue: provided,
    });
    return { ok: true, idempotencyKey, ...tryParseJson(input.rawBytes) };
  },
};

function extractCandidate(cfg: any, input: VerifyInput): string | undefined {
  switch (cfg.placement) {
    case "header":
      return input.headers[(cfg.fieldName ?? "").toLowerCase()] || undefined;
    case "bearer": {
      const h = input.headers["authorization"] ?? "";
      return h.startsWith("Bearer ") ? h.slice(7) : undefined;
    }
    case "basic": {
      const h = input.headers["authorization"] ?? "";
      if (!h.startsWith("Basic ")) return undefined;
      const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      return idx === -1 ? decoded : decoded.slice(idx + 1); // password segment
    }
    case "body": {
      const parsed = tryParseJson(input.rawBytes).parsedEvent as
        | Record<string, unknown>
        | undefined;
      const v = parsed?.[cfg.fieldName ?? ""];
      return typeof v === "string" ? v : undefined;
    }
    default:
      return undefined;
  }
}

function failSS(error: string, cfg: any, input: VerifyInput): VerifierResult {
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
