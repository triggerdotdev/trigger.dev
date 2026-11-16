import { redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { getUserSession } from "~/services/sessionStorage.server";
import { sanitizeRedirectPath } from "~/utils";
import {
  isMfaSetupRequired,
  isMfaVerificationFresh,
  stepUpWindowMinutes,
} from "./mfaRequirement.server";
import type { MfaStepUpAction } from "~/utils/mfaStepUp";
import { accountSecurityPath, confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const MFA_VERIFIED_AT_SESSION_KEY = "mfa-verified-at";

const MFA_VERIFY_PATH = "/mfa/verify";

const MFA_SETUP_PATH = "/mfa/setup";

// Everything a member locked out by an org's MFA requirement can still reach: the pages to set
// MFA up, the endpoint that sets it up, logout, and the onboarding page `_app` redirects to.
const SETUP_ALLOWED_PATHS = new Set([
  MFA_SETUP_PATH,
  accountSecurityPath(),
  "/resources/account/mfa/setup",
  "/resources/account/session-duration",
  "/logout",
  confirmBasicDetailsPath(),
]);

/** Sends a locked-out member to MFA setup from any page but the ones they need to set it up. */
export async function enforceMfaSetup(request: Request, userId: string): Promise<void> {
  const { pathname } = new URL(request.url);
  if (SETUP_ALLOWED_PATHS.has(pathname.replace(/\/$/, "") || "/")) return;
  if (!(await isMfaSetupRequired(userId))) return;
  throw redirect(`${MFA_SETUP_PATH}?${new URLSearchParams([["redirectTo", returnPath(request)]])}`);
}

// Where to come back to afterwards. A form post returns to the page it was posted from.
function returnPath(request: Request): string {
  const url = new URL(request.url);
  if (request.method === "GET") {
    url.searchParams.delete("_data");
    return sanitizeRedirectPath(`${url.pathname}${url.search}`);
  }
  const referer = request.headers.get("referer");
  const refererUrl = referer && URL.canParse(referer) ? new URL(referer) : undefined;
  if (refererUrl && refererUrl.origin === url.origin) {
    return sanitizeRedirectPath(`${refererUrl.pathname}${refererUrl.search}`);
  }
  return sanitizeRedirectPath(url.pathname);
}

/**
 * Throws a redirect to the MFA check when one of the user's orgs requires it for this action
 * and the session hasn't passed one within that org's window. Platform admins and impersonation
 * skip it. Call it in the loader and action of every route that serves the action.
 */
export async function requireRecentMfa(
  request: Request,
  options: { userId: string; action: MfaStepUpAction; organizationId?: string }
): Promise<void> {
  // Only a live impersonation of this user skips: a former admin's leftover cookie names someone else.
  if ((await getImpersonationId(request)) === options.userId) return;

  const windowMinutes = await stepUpWindowMinutes(
    options.userId,
    options.action,
    options.organizationId
  );
  if (windowMinutes === undefined) return;

  const user = await prisma.user.findFirst({
    where: { id: options.userId },
    select: { mfaEnabledAt: true, admin: true },
  });
  if (user?.admin) return;
  if (!user?.mfaEnabledAt) {
    throw await redirectWithErrorMessage(
      accountSecurityPath(),
      request,
      "Your organization requires multi-factor authentication for that page. Set it up to continue."
    );
  }

  const session = await getUserSession(request);
  if (isMfaVerificationFresh(session.get(MFA_VERIFIED_AT_SESSION_KEY), windowMinutes)) return;

  const searchParams = new URLSearchParams([["redirectTo", returnPath(request)]]);
  throw redirect(`${MFA_VERIFY_PATH}?${searchParams}`);
}
