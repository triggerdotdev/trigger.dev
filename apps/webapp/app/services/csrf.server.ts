import { randomBytes, timingSafeEqual } from "node:crypto";
import { commitSession, getUserSession } from "./sessionStorage.server";

const CSRF_SESSION_KEY = "csrfToken";

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Returns the session's CSRF token, minting it on first use. `setCookie` is set only when the session changed. */
export async function getCsrfToken(
  request: Request
): Promise<{ token: string; setCookie?: string }> {
  const session = await getUserSession(request);
  const existing = session.get(CSRF_SESSION_KEY);
  if (typeof existing === "string" && existing.length > 0) {
    return { token: existing };
  }

  const token = randomBytes(32).toString("base64url");
  session.set(CSRF_SESSION_KEY, token);
  return { token, setCookie: await commitSession(session) };
}

export async function verifyCsrfToken(request: Request, submitted: unknown): Promise<boolean> {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const session = await getUserSession(request);
  const expected = session.get(CSRF_SESSION_KEY);
  return typeof expected === "string" && safeEqual(expected, submitted);
}
