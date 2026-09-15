import { createCookie } from "@remix-run/node";
import { env } from "~/env.server";

// Post-auth redirect cookies. Kept in a .server module: Vite can't strip
// non-standard route exports that pull in server-only code.

export const githubRedirectCookie = createCookie("redirect-to", {
  maxAge: 60 * 60, // 1 hour
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export const googleRedirectCookie = createCookie("google-redirect-to", {
  maxAge: 60 * 60, // 1 hour
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});
