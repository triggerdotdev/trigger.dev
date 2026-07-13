import type { GoogleProfile } from "remix-auth-google";

/**
 * Whether Google has asserted that the profile's email is verified. A
 * successful OAuth flow proves control of the Google account, not ownership of
 * the email it carries, and account linking keys off the email.
 *
 * Strict by design: only a real boolean `true` counts. A missing claim, missing
 * `_json`, the string `"true"`, or a truthy `1` are all treated as unverified.
 */
export function isGoogleEmailVerified(profile: GoogleProfile): boolean {
  const emailVerified = (profile as { _json?: { email_verified?: unknown } })?._json
    ?.email_verified;
  return emailVerified === true;
}
