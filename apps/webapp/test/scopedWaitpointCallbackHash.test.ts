import { describe, expect, it } from "vitest";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  generateHttpCallbackUrl,
  verifyHttpCallbackHash,
} from "../app/services/httpCallback.server";
import {
  generateScopedHttpCallbackHash,
  readHttpCallbackScope,
  verifyScopedHttpCallbackHash,
} from "../app/services/httpCallbackHash.server";

describe("scoped waitpoint callback hash", () => {
  const scope = { waitpointId: "waitpoint-test", environmentId: "environment-test" };
  const key = "test-api-key";

  it.each(["DATETIME", "MANUAL"] as const)(
    "generates a scoped production callback URL for native %s tokens",
    (type) => {
      const waitpointId = generateWaitpointId(type);
      const url = new URL(generateHttpCallbackUrl(waitpointId, key, scope));
      const hash = url.pathname.split("/").pop()!;
      expect(hash).toMatch(/^wp1\./);
      expect(readHttpCallbackScope(hash)).toEqual({
        waitpointId,
        environmentId: scope.environmentId,
      });
      expect(verifyScopedHttpCallbackHash(waitpointId, scope.environmentId, hash, key)).toBe(true);
      expect(verifyScopedHttpCallbackHash(waitpointId, "other-environment", hash, key)).toBe(false);
      expect(
        verifyScopedHttpCallbackHash(waitpointId, scope.environmentId, hash, "rotated-key")
      ).toBe(false);
    }
  );

  it("keeps legacy and unscoped callback URLs on their existing hash protocol", () => {
    for (const [waitpointId, callbackScope] of [
      ["c".repeat(25), scope],
      [generateWaitpointId("MANUAL"), undefined],
    ] as const) {
      const url = new URL(generateHttpCallbackUrl(waitpointId, key, callbackScope));
      const hash = url.pathname.split("/").pop()!;
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(readHttpCallbackScope(hash)).toBeUndefined();
      expect(verifyHttpCallbackHash(waitpointId, hash, key)).toBe(true);
    }
  });

  it("preserves a URL-safe opaque hash bound to both the waitpoint and its environment", () => {
    const hash = generateScopedHttpCallbackHash(scope, key);
    expect(hash).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(readHttpCallbackScope(hash)).toEqual(scope);
    expect(verifyScopedHttpCallbackHash(scope.waitpointId, scope.environmentId, hash, key)).toBe(
      true
    );
    expect(verifyScopedHttpCallbackHash("other-waitpoint", scope.environmentId, hash, key)).toBe(
      false
    );
    expect(verifyScopedHttpCallbackHash(scope.waitpointId, "other-environment", hash, key)).toBe(
      false
    );
    expect(
      verifyScopedHttpCallbackHash(scope.waitpointId, scope.environmentId, hash, "rotated-key")
    ).toBe(false);
  });

  it("rejects payload or signature changes without accepting the decoded lookup context", () => {
    const hash = generateScopedHttpCallbackHash(scope, key);
    const [prefix, , signature] = hash.split(".");
    const changedPayload = Buffer.from(
      JSON.stringify([scope.waitpointId, "other-environment"])
    ).toString("base64url");
    expect(
      verifyScopedHttpCallbackHash(
        scope.waitpointId,
        "other-environment",
        `${prefix}.${changedPayload}.${signature}`,
        key
      )
    ).toBe(false);
    const changedSignature = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
    expect(
      verifyScopedHttpCallbackHash(scope.waitpointId, scope.environmentId, changedSignature, key)
    ).toBe(false);
  });

  it("rejects malformed and oversized scoped hashes without throwing; legacy hashes stay outside this protocol", () => {
    for (const hash of [
      "",
      "f".repeat(64),
      "wp1.a.deadbeef",
      "wp1.!invalid!." + "a".repeat(64),
      "wp1." + "a".repeat(2048),
    ]) {
      expect(readHttpCallbackScope(hash)).toBeUndefined();
      expect(verifyScopedHttpCallbackHash(scope.waitpointId, scope.environmentId, hash, key)).toBe(
        false
      );
    }
  });
});
