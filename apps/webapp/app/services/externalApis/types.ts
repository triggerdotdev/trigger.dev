import { z } from "zod";

export type Integration = {
  /** Used to uniquely identify an integration */
  identifier: string;
  /** identifier is used by default as the icon name, but you can specify a different one using icon */
  icon?: string;
  /** The name of the integration */
  name: string;
  /** The description of the integration */
  description?: string;
  /** Package name */
  packageName: string;
  /** All the authentication methods we support for this integration  */
  authenticationMethods: Record<string, ApiAuthenticationMethod>;
};

/** An authentication method that can be used */
export type ApiAuthenticationMethod = ApiAuthenticationMethodOAuth2 | ApiAuthenticationMethodApiKey;

const HelpSampleSchema = z.object({
  title: z.string(),
  code: z.string(),
  highlight: z.array(z.tuple([z.number(), z.number()])).optional(),
});

export const HelpSchema = z.object({
  samples: z.array(HelpSampleSchema),
});

export type Help = z.infer<typeof HelpSchema>;
export type HelpSample = z.infer<typeof HelpSampleSchema>;

export type ApiAuthenticationMethodApiKey = {
  /** The type of authentication method */
  type: "apikey";
  help: Help;
};

//A useful reference is the Simple OAuth2 npm library: https://github.com/lelylan/simple-oauth2/blob/HEAD/API.md#options
export type ApiAuthenticationMethodOAuth2 = {
  /** The displayable name of the authentication method */
  name: string;
  /** The description of the authentication method, displayed in the UI to help when choosing between them */
  description?: string;
  /** The type of authentication method */
  type: "oauth2";
  /** Client configuration */
  client: {
    id: {
      /** The ENV var to get the id from */
      envName: string;
      /** The param name to use to send the client id, default to "client_id" */
      paramName?: string;
    };
    secret: {
      /** The ENV var to get the secret from */
      envName: string;
      /** The param name to use to send the client secret, default to "client_secret" */
      paramName?: string;
    };
  };
  config: {
    /** Authorization is used to generate an OAuth url for the user to do */
    authorization: {
      url: string;
      /** The string that is used to separate the scopes, usually a space or comma */
      scopeSeparator: string;
      /** The param name of the scope, default is just "scope". Slack has "user" scopes that are a different query param */
      scopeParamName?: string;
      /** The location of the authorization header, default is "body" */
      authorizationLocation?: AuthorizationLocation;
      /** Additional parameters to send to the authorization url */
      extraParameters?: Record<string, string>;
      /** Some APIs have strange urls, this allows total control to deal with that */
      createUrlStrategy?: string;
    };
    /** Token is how a token is obtained */
    token: {
      url: string;
      /** How to fetch the metadata from the token */
      metadata: {
        /** JSONPointer to the owner info in the raw token response */
        accountPointer?: string;
      };
      /** The access_token key in the token. Default to "/access_token" */
      accessTokenPointer?: string;
      /** The refresh_token key in the token. Default to "/refresh_token" */
      refreshTokenPointer?: string;
      /** The expires_in key in the token. Default to "/expires_in" */
      expiresInPointer?: string;
      /** The scope key in the token. Default to "/scope" */
      scopePointer?: string;
      /** Some APIs have strange granting logic, this allows total control to deal with that */
      grantTokenStrategy?: string;
      /** Format of data sent in the request body. Defaults to form. */
      bodyFormat?: "form" | "json";
      /**
       * Indicates the method used to send the client.id/client.secret authorization params at the token request.
       * If set to body, the bodyFormat option will be used to format the credentials.
       * Defaults to header
       */
      authorizationMethod?: "header" | "body";
    };
    /** Refresh is how a token is refreshed */
    refresh: {
      url: string;
      /** Skip including scopes with the refresh_token request */
      skipScopes?: boolean;
      /** Some APIs have strange refreshing logic, this allows total control to deal with that */
      refreshTokenStrategy?: string;
    };
    /** Proof Key of Code Exchange (PKCE) is an extension of the standard authorization code grant OAuth flow. Defaults to true */
    pkce?: boolean;
    /** The ENV var to get the app hostname from, defaults to APP_ORIGIN */
    appHostEnvName?: string;
  };
  /** Additional fields that are needed, e.g. Shopify requires a store name */
  additionalFields?: AdditionalField[];
  /** The possible scopes this auth method supports */
  scopes: Scope[];
  help: Help;
};

export type AuthorizationLocation = "header" | "body";

export type CreateUrlParams = {
  authorizationUrl: string;
  clientId: string;
  clientSecret: string;
  key: string;
  callbackUrl: string;
  scopeParamName: string;
  scopes: string[];
  scopeSeparator: string;
  pkceCode?: string;
  authorizationLocation: AuthorizationLocation;
  extraParameters?: Record<string, string>;
};

export type GrantTokenParams = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  callbackUrl: string;
  requestedScopes: string[];
  scopeSeparator: string;
  accessTokenPointer: string;
  refreshTokenPointer: string;
  expiresInPointer: string;
  scopePointer: string;
  pkceCode?: string;
  authorizationMethod?: "header" | "body";
  bodyFormat?: "form" | "json";
};

export type RefreshTokenParams = {
  refreshUrl: string;
  clientId: string;
  clientSecret: string;
  requestedScopes: string[];
  scopeSeparator: string;
  token: { accessToken: string; refreshToken: string; expiresAt: Date };
  accessTokenPointer: string;
  refreshTokenPointer: string;
  expiresInPointer: string;
  scopePointer: string;
  authorizationMethod?: "header" | "body";
  bodyFormat?: "form" | "json";
  skipScopes?: boolean;
};

type AdditionalField = {
  /** The name of the field */
  name: string;
  /** The key of the field, should be unique */
  key: string;
  /** The type of the field */
  type: "text" | "password";
};

export type Scope = {
  /** The name of the scope */
  name: string;
  /** Description */
  description?: string;
  /** Default state of the checkbox. If unspecified it's false */
  defaultChecked?: boolean;
  /** Optional annotation that can appear next to the option  */
  annotations?: ScopeAnnotation[];
};

export type ScopeAnnotation = {
  label: string;
};

const OAuth2AccessTokenSchema = z.object({
  type: z.literal("oauth2"),
  accessToken: z.string(),
  expiresIn: z.number().optional(),
  refreshToken: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  raw: z.record(z.any()).optional(),
});

export const AccessTokenSchema = OAuth2AccessTokenSchema;
export type AccessToken = z.infer<typeof AccessTokenSchema>;

export const ConnectionMetadataSchema = z.object({
  account: z.string().optional(),
});

export type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;

export const OAuthClientSchema = z.object({
  id: z.string(),
  secret: z.string(),
});
export type OAuthClient = z.infer<typeof OAuthClientSchema>;
