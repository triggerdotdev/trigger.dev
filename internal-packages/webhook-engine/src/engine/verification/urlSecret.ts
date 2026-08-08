import type { WebhookUrlSecretConfig as UrlSecretConfig } from "@trigger.dev/core/v3";
import type { SchemeVerifier, VerifierResult, VerifyInput } from "./types.js";
import { constantTimeEqual } from "./util.js";
import { deriveIdempotencyKey, tryParseJson } from "./derive.js";

export const urlSecretVerifier: SchemeVerifier = {
  scheme: "url-secret",
  verify(config, input): VerifierResult {
    const cfg = config as Extract<UrlSecretConfig, { scheme: "url-secret" }>;
    const u = new URL(input.url);
    let provided: string | undefined;
    if (cfg.placement === "query") {
      provided = u.searchParams.get(cfg.paramName) ?? undefined;
    } else {
      const segs = u.pathname.split("/").filter(Boolean);
      provided = segs[segs.length - 1];
    }
    if (!provided)
      return { ok: false, error: "missing url secret", idempotencyKey: derive0(cfg, input) };
    if (!constantTimeEqual(provided, input.secret))
      return { ok: false, error: "url secret mismatch", idempotencyKey: derive0(cfg, input) };
    return {
      ok: true,
      idempotencyKey: derive0(cfg, input, provided),
      ...tryParseJson(input.rawBytes),
    };
  },
};

function derive0(cfg: any, input: VerifyInput, sig = ""): string {
  return deriveIdempotencyKey({
    idempotencyField: undefined,
    headers: input.headers,
    rawBytes: input.rawBytes,
    timestampValue: "",
    signatureValue: sig,
  });
}
