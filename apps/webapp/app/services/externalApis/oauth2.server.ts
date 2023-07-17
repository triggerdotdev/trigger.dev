import simpleOauth2 from "simple-oauth2";
import * as crypto from "node:crypto";
import type {
  AccessToken,
  CreateUrlParams,
  GrantTokenParams,
  OAuthClient,
  RefreshTokenParams,
} from "./types";
import jsonpointer from "jsonpointer";

export function getClientConfig({
  env,
  customOAuthClient,
}: {
  env: { idName: string; secretName: string };
  customOAuthClient?: OAuthClient;
}) {
  if (customOAuthClient) {
    return customOAuthClient;
  }

  //get the client id and secret from env vars
  const id = process.env[env.idName];
  if (!id) {
    throw new Error(`Client id environment variable not found: ${env.idName}`);
  }

  const secret = process.env[env.secretName];
  if (!secret) {
    throw new Error(
      `Client secret environment variable not found: ${env.secretName}`
    );
  }

  return {
    id,
    secret,
  };
}

export function createOAuth2Url(
  {
    authorizationUrl,
    clientId,
    clientSecret,
    key,
    callbackUrl,
    scopeParamName,
    scopes,
    scopeSeparator,
    pkceCode,
    authorizationLocation,
    extraParameters,
  }: CreateUrlParams,
  strategy?: string
) {
  if (strategy) {
    throw new Error(`createOauth2Url ${strategy} not implemented`);
  }

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
    code_challenge_method: codeChallenge ? "sha256" : undefined,
  };

  const scopeParams: Record<string, string> = {};
  scopeParams[scopeParamName] = scopes.join(scopeSeparator);

  //create the authorization url
  const authorizeUrl = simpleOAuthClient.authorizeURL({
    redirect_uri: callbackUrl,
    state: key,
    ...pkceParams,
    ...extraParameters,
    ...scopeParams,
  });

  return authorizeUrl;
}

export async function grantOAuth2Token(
  {
    tokenUrl,
    clientId,
    clientSecret,
    code,
    callbackUrl,
    requestedScopes,
    scopeSeparator,
    accessTokenPointer,
    refreshTokenPointer,
    expiresInPointer,
    scopePointer,
    pkceCode,
  }: GrantTokenParams,
  strategy?: string
): Promise<AccessToken> {
  if (strategy) {
    throw new Error(`grantOAuth2Token ${strategy} not implemented`);
  }

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
    scopePointer,
    accessTokenPointer,
    refreshTokenPointer,
    expiresInPointer,
  });
}

export async function refreshOAuth2Token(
  {
    refreshUrl,
    clientId,
    clientSecret,
    requestedScopes,
    scopeSeparator,
    token: { accessToken, refreshToken, expiresAt },
    accessTokenPointer,
    refreshTokenPointer,
    expiresInPointer,
    scopePointer,
  }: RefreshTokenParams,
  strategy?: string
) {
  if (strategy) {
    throw new Error(`refreshOAuth2Token ${strategy} not implemented`);
  }

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
    scopePointer,
    accessTokenPointer,
    refreshTokenPointer,
    expiresInPointer,
  });
}

function convertToken({
  token,
  accessTokenPointer,
  refreshTokenPointer,
  expiresInPointer,
  scopePointer,
  requestedScopes,
  scopeSeparator,
}: {
  token: simpleOauth2.AccessToken;
  accessTokenPointer: string;
  refreshTokenPointer: string;
  expiresInPointer: string;
  scopePointer: string;
  requestedScopes: string[];
  scopeSeparator: string;
}) {
  const accessTokenPtr = jsonpointer.compile(accessTokenPointer);
  const accessTokenValue = accessTokenPtr.get(token.token);
  if (typeof accessTokenValue !== "string") {
    throw new Error("Invalid access token");
  }

  let actualScopes = requestedScopes;
  const scopesPtr = jsonpointer.compile(scopePointer);
  const scopesValue = scopesPtr.get(token.token);
  if (typeof scopesValue === "string") {
    actualScopes = (scopesValue as string).split(scopeSeparator);
  }

  const refreshTokenPtr = jsonpointer.compile(refreshTokenPointer);
  const refreshToken = refreshTokenPtr.get(token.token) as string | undefined;

  const expiresInPtr = jsonpointer.compile(expiresInPointer);
  const expiresIn = expiresInPtr.get(token.token) as number | undefined;

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
