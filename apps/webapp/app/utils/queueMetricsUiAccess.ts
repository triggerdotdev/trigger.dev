/**
 * The rule for who sees the Queue Metrics dashboard UI.
 *
 * Kept pure and free of server-only imports so it can be unit tested directly,
 * and so there is one definition of the rule for the server gate to share.
 */

/**
 * Resolves the per-org feature flag against the request's impersonation state.
 *
 * The bypass exists so an admin can preview the UI for a real org before it is
 * revealed to that org's members, which the flag alone cannot express: flags are
 * org-scoped, so turning one on to look at the UI exposes every member of the org.
 *
 * It keys on impersonation rather than `user.admin` because impersonation is
 * scoped to one org and is a deliberate act, where admin status is neither — an
 * admin browsing their own orgs would otherwise silently get the preview
 * everywhere.
 *
 * It yields to `isViewingAsUser`, which is the admin asking to see exactly what
 * the member sees; previewing unreleased UI through that toggle would make it
 * lie. Suppressing the preview there only ever hides a read-only view, so it
 * stays inside the display-only contract that toggle is held to.
 *
 * The caller is responsible for only reporting `isImpersonating` for an
 * impersonation into a member of the org being resolved, so the bypass cannot
 * reach across orgs.
 */
export function resolveQueueMetricsUiAccess(options: {
  flagEnabled: boolean;
  isImpersonating: boolean;
  isViewingAsUser: boolean;
}): boolean {
  const { flagEnabled, isImpersonating, isViewingAsUser } = options;

  if (flagEnabled) {
    return true;
  }

  return isImpersonating && !isViewingAsUser;
}
