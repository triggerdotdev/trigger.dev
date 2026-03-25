import { createCookieSessionStorage } from "@remix-run/node";
import { randomBytes } from "crypto";
import { env } from "../env.server";
import { logger } from "./logger.server";

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__github_app_install",
    httpOnly: true,
    maxAge: 60 * 60, // 1 hour
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
  },
});

/**
 * Creates a secure session for GitHub App installation with organization tracking
 */
export async function createGitHubAppInstallSession(
  organizationId: string,
  redirectTo: string
): Promise<{ url: string; cookieHeader: string }> {
  if (env.GITHUB_APP_ENABLED !== "1") {
    throw new Error("GitHub App is not enabled");
  }

  const state = randomBytes(32).toString("hex");

  const session = await sessionStorage.getSession();
  session.set("organizationId", organizationId);
  session.set("redirectTo", redirectTo);
  session.set("state", state);
  session.set("createdAt", Date.now());

  const githubAppSlug = env.GITHUB_APP_SLUG;

  // the state query param gets passed through to the installation callback
  const url = `https://github.com/apps/${githubAppSlug}/installations/new?state=${state}`;

  const cookieHeader = await sessionStorage.commitSession(session);

  return { url, cookieHeader };
}

/**
 * Validates and retrieves the GitHub App installation session
 */
export async function validateGitHubAppInstallSession(
  cookieHeader: string | null,
  state: string
): Promise<
  { valid: true; organizationId: string; redirectTo: string } | { valid: false; error?: string }
> {
  if (!cookieHeader) {
    return {
      valid: false,
      error: "No installation session cookie found",
    };
  }

  const session = await sessionStorage.getSession(cookieHeader);

  const sessionState = session.get("state");
  const organizationId = session.get("organizationId");
  const redirectTo = session.get("redirectTo");
  const createdAt = session.get("createdAt");

  if (!sessionState || !organizationId || !createdAt || !redirectTo) {
    logger.warn("GitHub App installation session missing required fields", {
      hasState: !!sessionState,
      hasOrgId: !!organizationId,
      hasCreatedAt: !!createdAt,
      hasRedirectTo: !!redirectTo,
    });

    return {
      valid: false,
      error: "invalid_session_data",
    };
  }

  if (sessionState !== state) {
    logger.warn("GitHub App installation state mismatch", {
      expectedState: sessionState,
      receivedState: state,
    });
    return {
      valid: false,
      error: "state_mismatch",
    };
  }

  const expirationTime = createdAt + 60 * 60 * 1000;
  if (Date.now() > expirationTime) {
    logger.warn("GitHub App installation session expired", {
      createdAt: new Date(createdAt),
      now: new Date(),
    });
    return {
      valid: false,
      error: "session_expired",
    };
  }

  return {
    valid: true,
    organizationId,
    redirectTo,
  };
}

/**
 * Destroys the GitHub App installation cookie session
 */
export async function destroyGitHubAppInstallSession(cookieHeader: string | null): Promise<string> {
  if (!cookieHeader) {
    return "";
  }

  const session = await sessionStorage.getSession(cookieHeader);
  return await sessionStorage.destroySession(session);
}
