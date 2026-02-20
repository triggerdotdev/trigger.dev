import { createCookie } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { telemetry } from "~/services/telemetry.server";

const ReferralSourceSchema = z.enum(["vercel"]);

export type ReferralSource = z.infer<typeof ReferralSourceSchema>;

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
  const parsed = ReferralSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function setReferralSourceCookie(source: ReferralSource): Promise<string> {
  return referralSourceCookie.serialize(source);
}

export async function clearReferralSourceCookie(): Promise<string> {
  return referralSourceCookie.serialize("", {
    maxAge: 0,
  });
}

export async function trackAndClearReferralSource(
  request: Request,
  userId: string,
  headers: Headers
): Promise<void> {
  const referralSource = await getReferralSource(request);
  if (!referralSource) return;

  headers.append("Set-Cookie", await clearReferralSourceCookie());

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const userAge = Date.now() - user.createdAt.getTime();
  if (userAge >= 30 * 1000) return;

  telemetry.user.identify({ user, isNewUser: true, referralSource });
}
