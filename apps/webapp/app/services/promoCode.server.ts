import { createCookie } from "@remix-run/node";
import { env } from "~/env.server";

// Carries a promo code from the landing page through signup to first-org
// creation. httpOnly + sameSite=lax so it survives the OAuth round-trip,
// matching the existing redirect-to cookie.
export const promoCodeCookie = createCookie("promo-code", {
  maxAge: 60 * 60, // 1 hour — enough to complete signup
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/",
});

export async function setPromoCodeCookie(code: string): Promise<string> {
  return await promoCodeCookie.serialize(code);
}

export async function getPromoCodeFromCookie(request: Request): Promise<string | null> {
  const value = await promoCodeCookie.parse(request.headers.get("Cookie"));
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function clearPromoCodeCookie(): Promise<string> {
  return await promoCodeCookie.serialize("", { maxAge: 0 });
}
