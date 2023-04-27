import simpleOauth2 from "simple-oauth2";
import * as crypto from "node:crypto";
import type {
  AccessToken,
  CreateUrlParams,
  GrantTokenParams,
  RefreshTokenParams,
} from "./types";

export function getClientConfigFromEnv(idName: string, secretName: string) {
  //get the client id and secret from env vars
  const id = process.env[idName];
  if (!id) {
    throw new Error(`Client id environment variable not found: ${idName}`);
  }

  const secret = process.env[secretName];
  if (!secret) {
    throw new Error(
      `Client secret environment variable not found: ${secretName}`
    );
  }

  return {
    id,
    secret,
  };
}

export async function createOAuth2Url({
  authorizationUrl,
  clientId,
  clientSecret,
  key,
  callbackUrl,
  scopes,
  scopeSeparator,
  pkceCode,
  authorizationLocation,
  extraParameters,
}: CreateUrlParams) {
  //create the oauth2 client
  const authUrl = new URL(authorizationUrl);
  const authHost = `${authUrl.protocol}//${authUrl.host}`;

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      authorizeHost: authHost,
      authorizePath: authUrl.pathname,
      tokenHost: authHost,
    },
    options: {
      scopeSeparator,
      authorizationMethod: authorizationLocation,
    },
  };

  const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

  //PKCE
  let codeChallenge: string | undefined = undefined;
  if (pkceCode) {
    codeChallenge = crypto
      .createHash("sha256")
      .update(pkceCode)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  const pkceParams = {
    code_challenge: codeChallenge ?? undefined,
    code_challenge_method: codeChallenge ? "S256" : undefined,
  };

  //create the authorization url
  const authorizeUrl = simpleOAuthClient.authorizeURL({
    redirect_uri: callbackUrl,
    scope: scopes.join(scopeSeparator),
    state: key,
    ...pkceParams,
    ...extraParameters,
  });

  return authorizeUrl;
}

export async function grantOAuth2Token({
  tokenUrl,
  clientId,
  clientSecret,
  code,
  callbackUrl,
  requestedScopes,
  scopeSeparator,
  accessTokenKey,
  refreshTokenKey,
  expiresInKey,
  scopeKey,
  pkceCode,
}: GrantTokenParams): Promise<AccessToken> {
  //create the oauth2 client
  const tokenUrlObj = new URL(tokenUrl);

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      tokenHost: `${tokenUrlObj.protocol}//${tokenUrlObj.host}`,
      tokenPath: tokenUrlObj.pathname,
    },
  };

  const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

  let codeVerifier: string | undefined = undefined;
  if (pkceCode) {
    codeVerifier = pkceCode;
  }
  const pkceParams = {
    code_verifier: codeVerifier ?? undefined,
  };

  //create the authorization url
  const token = await simpleOAuthClient.getToken({
    code,
    redirect_uri: callbackUrl,
    scope: requestedScopes.join(scopeSeparator),
    ...pkceParams,
  });

  return convertToken({
    token,
    scopeSeparator,
    requestedScopes,
    scopeKey,
    accessTokenKey,
    refreshTokenKey,
    expiresInKey,
  });
}

export async function refreshOAuth2Token({
  refreshUrl,
  clientId,
  clientSecret,
  callbackUrl,
  requestedScopes,
  scopeSeparator,
  token: { accessToken, refreshToken, expiresAt },
  accessTokenKey,
  refreshTokenKey,
  expiresInKey,
  scopeKey,
}: RefreshTokenParams) {
  //create the oauth2 client
  const tokenUrlObj = new URL(refreshUrl);

  const clientConfig = {
    client: {
      id: clientId,
      secret: clientSecret,
    },
    auth: {
      tokenHost: `${tokenUrlObj.protocol}//${tokenUrlObj.host}`,
      tokenPath: tokenUrlObj.pathname,
      refreshPath: tokenUrlObj.pathname,
    },
  };

  const simpleOAuthClient = new simpleOauth2.AuthorizationCode(clientConfig);

  //get the old token
  const oldToken = simpleOAuthClient.createToken({
    access_token: accessToken,
    expires_at: expiresAt,
    refresh_token: refreshToken,
  });

  const newToken = await oldToken.refresh({
    scope: requestedScopes.join(scopeSeparator),
  });

  return convertToken({
    token: newToken,
    scopeSeparator,
    requestedScopes,
    scopeKey,
    accessTokenKey,
    refreshTokenKey,
    expiresInKey,
  });
}

function convertToken({
  token,
  accessTokenKey,
  refreshTokenKey,
  expiresInKey,
  scopeKey,
  requestedScopes,
  scopeSeparator,
}: {
  token: simpleOauth2.AccessToken;
  accessTokenKey: string;
  refreshTokenKey: string;
  expiresInKey: string;
  scopeKey: string;
  requestedScopes: string[];
  scopeSeparator: string;
}) {
  const accessTokenValue = token.token[accessTokenKey];
  if (typeof accessTokenValue !== "string") {
    throw new Error("Invalid access token");
  }

  let actualScopes = requestedScopes;
  if (typeof token.token[scopeKey] === "string") {
    actualScopes = (token.token[scopeKey] as string).split(scopeSeparator);
  }

  const refreshToken = token.token[refreshTokenKey] as string | undefined;
  const expiresIn = token.token[expiresInKey] as number | undefined;

  const accessToken: AccessToken = {
    type: "oauth2",
    accessToken: accessTokenValue,
    refreshToken,
    expiresIn,
    scopes: actualScopes,
    raw: token.token,
  };

  return accessToken;
}
