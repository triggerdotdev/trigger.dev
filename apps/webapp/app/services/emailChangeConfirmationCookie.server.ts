import { createCookie } from "@remix-run/node";
import { env } from "~/env.server";

// Redirect off the bearer-token URL before rendering a page that runs analytics.
export const emailChangeConfirmationCookie = createCookie("email-change-confirmation", {
  maxAge: 60 * 60,
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/account/email/confirm",
  secrets: [env.SESSION_SECRET],
});
