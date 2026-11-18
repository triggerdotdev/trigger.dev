import { describe, expect, it } from "vitest";
import { canFallbackToLocalPublicToken } from "./publicTokenCompatibility.js";

const rootKey = "tr_prod_0123456789abcdefghijklmn";
const emptyScopesError = {
  error: "Invalid request body",
  issues: [{ code: "too_small", minimum: 1, inclusive: true, path: ["scopes"] }],
};

// Catches: compatibility fallback bypassing server policy or attempting to sign with a non-root key.
describe("legacy public-token compatibility", () => {
  it("accepts only a missing endpoint or the legacy empty-scope rejection", () => {
    expect(canFallbackToLocalPublicToken(rootKey, ["read:runs"], 404)).toBe(true);
    expect(canFallbackToLocalPublicToken("tr_prod_0123456789abcdefghij", ["read:runs"], 404)).toBe(
      true
    );
    expect(canFallbackToLocalPublicToken(rootKey, [], 400, emptyScopesError)).toBe(true);
    expect(canFallbackToLocalPublicToken(rootKey, ["read:runs"], 400, emptyScopesError)).toBe(
      false
    );
  });

  it("never permits additional keys, run tokens or other credentials to self-sign", () => {
    for (const key of [
      "tr_prod_sk_0123456789abcdefghijklmn",
      "eyJhbGciOiJSUzI1NiJ9.eyJ0b2tlbl91c2UiOiJydW4ifQ.signature",
      "tr_pat_0123456789abcdefghijklmn",
      "unknown",
    ]) {
      expect(canFallbackToLocalPublicToken(key, [], 404)).toBe(false);
      expect(canFallbackToLocalPublicToken(key, [], 400, emptyScopesError)).toBe(false);
    }
  });

  it("does not reinterpret authorization, expiration, rate-limit or availability failures", () => {
    for (const status of [undefined, 401, 403, 429, 500, 503]) {
      expect(canFallbackToLocalPublicToken(rootKey, [], status, emptyScopesError)).toBe(false);
    }
    for (const body of [
      undefined,
      { error: "Invalid request body" },
      { error: "Invalid expiration time" },
      { ...emptyScopesError, issues: [...emptyScopesError.issues, { path: ["expirationTime"] }] },
    ]) {
      expect(canFallbackToLocalPublicToken(rootKey, [], 400, body)).toBe(false);
    }
  });
});
