import { env } from "~/env.server";

export function assertEmailAllowed(email: string) {
  if (!env.WHITELISTED_EMAILS) {
    return;
  }

  const regexp = new RegExp(env.WHITELISTED_EMAILS);

  if (!regexp.test(email)) {
    throw new Error("This email is unauthorized");
  }
}
