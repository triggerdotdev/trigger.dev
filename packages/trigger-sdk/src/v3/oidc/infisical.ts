import { auth } from "../auth.js";

const DEFAULT_SITE_URL = "https://us.infisical.com";

export type InfisicalAccessTokenOptions = {
  identityId: string;
  /** Defaults to https://us.infisical.com. Set this for EU or self-hosted instances. */
  siteUrl?: string;
  /** Defaults to siteUrl, without a trailing slash. Must match the identity's allowed audience. */
  audience?: string;
  /** Infisical organization to scope the session to. Defaults to the identity's organization. */
  organizationSlug?: string;
};

export type InfisicalAccessToken = {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: Date;
};

/** Authenticate inside run. Tokens are not cached; call again before expiresAt when needed. */
export async function infisicalAccessToken(
  options: InfisicalAccessTokenOptions
): Promise<InfisicalAccessToken> {
  const siteUrl = (options.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
  const loginUrl = new URL("api/v1/auth/oidc-auth/login", `${siteUrl}/`);
  const { token } = await auth.getOIDCToken({ audience: options.audience ?? siteUrl });
  const requestedAt = Date.now();
  const response = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identityId: options.identityId,
      jwt: token,
      organizationSlug: options.organizationSlug,
    }),
  });
  const result: unknown = await response.json().catch(() => undefined);
  const data =
    result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;

  if (!response.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message.replaceAll(token, "[redacted]")
        : response.statusText;
    throw new Error(`Infisical OIDC login failed (${response.status}): ${message}`);
  }

  if (
    typeof data?.accessToken !== "string" ||
    !data.accessToken.trim() ||
    data.tokenType !== "Bearer" ||
    typeof data.expiresIn !== "number" ||
    !Number.isFinite(data.expiresIn) ||
    data.expiresIn <= 0
  ) {
    throw new Error("Infisical OIDC login returned an invalid access token or expiration.");
  }

  const expiresAt = new Date(requestedAt + data.expiresIn * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Infisical OIDC login returned an invalid expiration.");
  }

  return { accessToken: data.accessToken, tokenType: "Bearer", expiresAt };
}
