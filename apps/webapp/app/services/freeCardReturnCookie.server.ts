import { createCookie } from "@remix-run/node";
import { env } from "~/env.server";

// Carries the card step's return target across Stripe's card page, which only knows the org id.
export const freeCardReturnCookie = createCookie("free-card-return-to", {
  maxAge: 60 * 60, // 1 hour
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});
