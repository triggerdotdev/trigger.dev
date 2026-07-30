/**
 * The rule for reading impersonation state off the impersonation cookie.
 *
 * Kept pure and free of server-only imports so it can be unit tested directly,
 * and so there is exactly one definition of "this request is impersonating" for
 * every caller to share.
 */

export type ImpersonationState = {
  isImpersonating: boolean;
  isViewingAsUser: boolean;
};

/**
 * Resolves the impersonation cookie's raw contents against the identity the
 * request actually authenticated as.
 *
 * Matching the impersonated id against `resolvedUserId` is deliberate. When an
 * admin's role is revoked mid-session the session falls back to the real admin's
 * id while the cookie still names the impersonation target, so "an impersonated
 * id is present" and "this request is impersonating" stop meaning the same
 * thing. Only the strict reading is correct there: that session is no longer
 * impersonating, and so it is not viewing as the user either.
 *
 * Every consumer has to agree on this, or the flags computed on the server and
 * the flag published to the client drift apart — the admin chrome would hide
 * itself on a session that is not impersonating at all.
 */
export function resolveImpersonationState(options: {
  impersonatedUserId: unknown;
  viewingAsUser: unknown;
  resolvedUserId: string | undefined;
}): ImpersonationState {
  const { impersonatedUserId, viewingAsUser, resolvedUserId } = options;

  const isImpersonating =
    typeof impersonatedUserId === "string" &&
    resolvedUserId !== undefined &&
    impersonatedUserId === resolvedUserId;

  return {
    isImpersonating,
    // Display only, and meaningless outside an impersonation session, so it
    // never reads as on without one.
    isViewingAsUser: isImpersonating && viewingAsUser === true,
  };
}
