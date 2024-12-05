import { createCookie } from "@remix-run/node";

export const redirectCookie = createCookie("redirect-to", {
  maxAge: 60 * 60, // 1 hour
  httpOnly: true,
});
