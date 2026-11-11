import { describe, expect, it } from "vitest";
import { validateJwtExpiration } from "../app/services/jwtExpiration.server";

const now = 1_800_000_000;

describe("JWT expiration", () => {
  // Catches: alternate duration/numeric inputs bypassing the cap or invalid input silently defaulting.
  it.each(["100y", 86401, now + 86401, "invalid", 0, -1, now - 1, Infinity, NaN])(
    "rejects invalid or out-of-bounds expiration %s",
    (expirationTime) => {
      expect(validateJwtExpiration(expirationTime, now).error).toBeDefined();
    }
  );

  // Catches: parsing changing the signed absolute expiry or rejecting the exact 24-hour boundary.
  it.each([
    [undefined, now + 3600],
    ["1h", now + 3600],
    ["24h", now + 86400],
    [86400, now + 86400],
    [now + 86400, now + 86400],
  ] as const)("resolves %s to an absolute capped expiry", (input, expected) => {
    expect(validateJwtExpiration(input, now)).toEqual({ expirationTime: expected });
  });
});
