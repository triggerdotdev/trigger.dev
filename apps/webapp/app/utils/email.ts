import { env } from "~/env.server";
import { emailMatchesPattern } from "./emailPattern";

export function assertEmailAllowed(email: string) {
  if (!env.WHITELISTED_EMAILS) {
    return;
  }

  if (!emailMatchesPattern(env.WHITELISTED_EMAILS, email)) {
    throw new Error("This email is unauthorized");
  }
}
