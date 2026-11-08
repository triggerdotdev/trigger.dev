import { env } from "~/env.server";
import { isSignInAllowed } from "~/services/accessPolicy.server";
import { emailDomainIsListed } from "./emailDomainList";
import { emailMatchesPattern } from "./emailPattern";

export function isEmailDomainBlocked(email: string): boolean {
  if (!env.BLOCKED_EMAIL_DOMAINS) {
    return false;
  }

  return emailDomainIsListed(env.BLOCKED_EMAIL_DOMAINS, email);
}

/** Whether the instance's rules and the access policy plugin accept the email. */
async function isEmailAllowed(email: string): Promise<boolean> {
  if (env.WHITELISTED_EMAILS && !emailMatchesPattern(env.WHITELISTED_EMAILS, email)) return false;
  return isSignInAllowed({ email, domainBlocked: isEmailDomainBlocked(email) });
}

export async function assertEmailAllowed(email: string) {
  if (!(await isEmailAllowed(email))) {
    // Surfaced verbatim on the login page. Name the actual policy so a
    // rejection on a restricted instance reads as configuration, not a bug.
    throw new Error("This email address isn't allowed to sign in on this instance.");
  }
}
