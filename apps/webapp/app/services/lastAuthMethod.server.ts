import { createCookie } from "@remix-run/node";

export type LastAuthMethod = "github" | "google" | "email";

// Cookie that persists for 1 year to remember the user's last login method
export const lastAuthMethodCookie = createCookie("last-auth-method", {
  maxAge: 60 * 60 * 24 * 365, // 1 year
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
});

export async function getLastAuthMethod(request: Request): Promise<LastAuthMethod | null> {
  const cookie = request.headers.get("Cookie");
  const value = await lastAuthMethodCookie.parse(cookie);
  if (value === "github" || value === "google" || value === "email") {
    return value;
  }
  return null;
}

export async function setLastAuthMethodHeader(method: LastAuthMethod): Promise<string> {
  return lastAuthMethodCookie.serialize(method);
}
