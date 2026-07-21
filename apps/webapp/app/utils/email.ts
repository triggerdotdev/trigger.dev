import { env } from "~/env.server";
import { emailMatchesPattern } from "./emailPattern";

export function assertEmailAllowed(email: string) {
  if (!env.WHITELISTED_EMAILS) {
    return;
  }

  if (!emailMatchesPattern(env.WHITELISTED_EMAILS, email)) {
    // Surfaced verbatim on the login page. Name the actual policy so a
    // rejection on a restricted instance reads as configuration, not a bug.
    throw new Error("This email address isn't allowed to sign in on this instance.");
  }
}
