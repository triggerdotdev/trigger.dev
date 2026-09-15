import type { GoogleProfile } from "remix-auth-google";
import { describe, expect, it } from "vitest";
import { isGoogleEmailVerified } from "../app/services/googleEmailVerification.js";

// Build a minimal Google profile carrying just the email_verified claim the
// guard inspects. The real profile is much larger; only _json.email_verified
// matters here.
const profileWith = (emailVerified: unknown): GoogleProfile =>
  ({ _json: { email_verified: emailVerified } }) as unknown as GoogleProfile;

describe("isGoogleEmailVerified", () => {
  it("accepts a profile Google marked email_verified === true", () => {
    expect(isGoogleEmailVerified(profileWith(true))).toBe(true);
  });

  it("rejects a profile with email_verified === false (the account-linking takeover vector)", () => {
    expect(isGoogleEmailVerified(profileWith(false))).toBe(false);
  });

  it("rejects when the email_verified claim is absent", () => {
    expect(isGoogleEmailVerified(profileWith(undefined))).toBe(false);
    // _json missing entirely
    expect(isGoogleEmailVerified({} as unknown as GoogleProfile)).toBe(false);
  });

  it("is strict: truthy non-true values do not count as verified", () => {
    // Google asserts a real boolean; a string "true"/"false" or a truthy number
    // means the claim wasn't a genuine verification and must not be trusted.
    expect(isGoogleEmailVerified(profileWith("true"))).toBe(false);
    expect(isGoogleEmailVerified(profileWith("false"))).toBe(false);
    expect(isGoogleEmailVerified(profileWith(1))).toBe(false);
  });
});
