import { createCookie } from "@remix-run/node";
import { env } from "~/env.server";

// Carries the submitted email to the confirmation screen in a short-lived,
// httpOnly cookie rather than the URL, so the address never lands in access
// logs, browser history, or error-tracker breadcrumbs. Lives in a .server
// module: it calls createCookie at import time using server-only env, which
// throws if it ever evaluates in the client bundle.
export const magicLinkEmailCookie = createCookie("magiclink-email", {
  maxAge: 60 * 10,
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/",
});
