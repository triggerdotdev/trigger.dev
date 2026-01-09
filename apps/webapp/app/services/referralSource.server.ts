import { createCookie } from "@remix-run/node";
import { env } from "~/env.server";

export type ReferralSource = "vercel";

// Cookie that persists for 1 hour to track referral source during login flow
export const referralSourceCookie = createCookie("referral-source", {
  maxAge: 60 * 60, // 1 hour
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export async function getReferralSource(request: Request): Promise<ReferralSource | null> {
  const cookie = request.headers.get("Cookie");
  const value = await referralSourceCookie.parse(cookie);
  if (value === "vercel") {
    return value;
  }
  return null;
}

export async function setReferralSourceCookie(source: ReferralSource): Promise<string> {
  return referralSourceCookie.serialize(source);
}

export async function clearReferralSourceCookie(): Promise<string> {
  return referralSourceCookie.serialize("", {
    maxAge: 0,
  });
}
