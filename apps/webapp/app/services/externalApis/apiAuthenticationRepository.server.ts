import type { ApiConnection, SecretReference } from ".prisma/client";
import jsonpointer from "jsonpointer";
import { customAlphabet, nanoid } from "nanoid";
import * as crypto from "node:crypto";
import createSlug from "slug";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { workerQueue } from "~/services/worker.server";
import type { SecretStoreProvider } from "../secrets/secretStore.server";
import { SecretStore } from "../secrets/secretStore.server";
import type { APIStore } from "./apiStore";
import { apiStore as apis } from "./apiStore";
import {
  createOAuth2Url,
  getClientConfigFromEnv,
  grantOAuth2Token,
  refreshOAuth2Token,
} from "./oauth2.server";
import type {
  AccessToken,
  APIAuthenticationMethodOAuth2,
  ConnectionMetadata,
  ExternalAPI,
  GrantTokenParams,
  RefreshTokenParams,
} from "./types";
import { AccessTokenSchema, ConnectionMetadataSchema } from "./types";

export type ApiConnectionWithSecretReference = ApiConnection & {
  dataReference: SecretReference;
};

const randomGenerator = customAlphabet("1234567890abcdef", 3);

/** How many seconds before expiry we should refresh the token  */
const tokenRefreshThreshold = 5 * 60;

export class APIAuthenticationRepository {
  #apiStore: APIStore;
  #prismaClient: PrismaClient;

  constructor(apiStore: APIStore = apis, prismaClient: PrismaClient = prisma) {
    this.#apiStore = apiStore;
    this.#prismaClient = prismaClient;
  }

  /** Get all API connections for the organization */
  async getAllConnections(organizationId: string) {
    const connections = await this.#prismaClient.apiConnection.findMany({
      where: {
        organizationId: organizationId,
      },
      orderBy: {
        title: "asc",
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  /** Get all API connections for the organization, for a specific API */
  async getConnectionsForApi(organizationId: string, api: ExternalAPI) {
    const connections = await this.#prismaClient.apiConnection.findMany({
      where: {
        organizationId: organizationId,
        apiIdentifier: api.identifier,
      },
    });

    return connections.map((c) => this.#enrichConnection(c));
  }

  async createConnectionAttempt({
    organizationId,
    apiIdentifier,
    authenticationMethodKey,
    scopes,
    title,
    redirectTo,
  }: {
    organizationId: string;
    apiIdentifier: string;
    authenticationMethodKey: string;
    scopes: string[];
    title: string;
    redirectTo: string;
  }) {
    const api = this.#apiStore.getApi(apiIdentifier);
    if (!api) {
      throw new Error(`API ${apiIdentifier} not found`);
    }

    const authenticationMethod =
      api.authenticationMethods[authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${authenticationMethodKey} not found for API ${apiIdentifier}`
      );
    }

    switch (authenticationMethod.type) {
      case "oauth2": {
        let pkceCode: string | undefined = undefined;
        if (authenticationMethod.config.pkce !== false) {
          pkceCode = crypto.randomBytes(24).toString("hex");
        }

        //create a connection attempt
        const connectionAttempt =
          await this.#prismaClient.apiConnectionAttempt.create({
            data: {
              organizationId: organizationId,
              apiIdentifier,
              authenticationMethodKey,
              scopes,
              title,
              redirectTo,
              securityCode: pkceCode,
            },
          });

        //create a url for the oauth2 flow
        const getClientConfig = getClientConfigFromEnv(
          authenticationMethod.client.id.envName,
          authenticationMethod.client.secret.envName
        );
        const callbackHostName = this.#callbackUrl(authenticationMethod);

        const createAuthorizationParams = {
          authorizationUrl: authenticationMethod.config.authorization.url,
          clientId: getClientConfig.id,
          clientSecret: getClientConfig.secret,
          key: connectionAttempt.id,
          callbackUrl: `${callbackHostName}/resources/connection/oauth2/callback`,
          scopes,
          scopeSeparator:
            authenticationMethod.config.authorization.scopeSeparator,
          pkceCode,
          authorizationLocation:
            authenticationMethod.config.authorization.authorizationLocation ??
            "body",
          extraParameters:
            authenticationMethod.config.authorization.extraParameters,
        };

        const authorizationUrl = await (authenticationMethod.config
          .authorization.createUrl
          ? authenticationMethod.config.authorization.createUrl(
              createAuthorizationParams
            )
          : createOAuth2Url(createAuthorizationParams));

        return authorizationUrl;
      }
      default: {
        throw new Error(
          `Authentication method type ${authenticationMethod.type} not supported`
        );
      }
    }
  }

  async createConnection({
    organizationId,
    apiIdentifier,
    authenticationMethodKey,
    scopes,
    code,
    title,
    pkceCode,
  }: {
    organizationId: string;
    apiIdentifier: string;
    authenticationMethodKey: string;
    scopes: string[];
    code: string;
    title: string;
    pkceCode?: string;
  }) {
    const api = this.#apiStore.getApi(apiIdentifier);
    if (!api) {
      throw new Error(`API ${apiIdentifier} not found`);
    }

    const authenticationMethod =
      api.authenticationMethods[authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${authenticationMethodKey} not found for API ${apiIdentifier}`
      );
    }

    switch (authenticationMethod.type) {
      case "oauth2": {
        const getClientConfig = getClientConfigFromEnv(
          authenticationMethod.client.id.envName,
          authenticationMethod.client.secret.envName
        );
        const callbackHostName = this.#callbackUrl(authenticationMethod);

        const params: GrantTokenParams = {
          tokenUrl: authenticationMethod.config.token.url,
          clientId: getClientConfig.id,
          clientSecret: getClientConfig.secret,
          code,
          callbackUrl: `${callbackHostName}/resources/connection/oauth2/callback`,
          requestedScopes: scopes,
          scopeSeparator:
            authenticationMethod.config.authorization.scopeSeparator,
          pkceCode,
          accessTokenKey:
            authenticationMethod.config.token.accessTokenKey ?? "access_token",
          refreshTokenKey:
            authenticationMethod.config.token.refreshTokenKey ??
            "refresh_token",
          expiresInKey:
            authenticationMethod.config.token.expiresInKey ?? "expires_in",
          scopeKey: authenticationMethod.config.token.scopeKey ?? "scope",
        };
        const token = await (authenticationMethod.config.token.grantToken
          ? authenticationMethod.config.token.grantToken(params)
          : grantOAuth2Token(params));

        //this key is used to store in the relevant SecretStore
        const hashedAccessToken = crypto
          .createHash("sha256")
          .update(token.accessToken)
          .digest("base64");
        const key = `${apiIdentifier}-${hashedAccessToken}`;

        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod,
        });

        let secretReference =
          await this.#prismaClient.secretReference.findUnique({
            where: {
              key,
            },
          });

        if (secretReference) {
          //if the secret reference already exists, update existing connections with the new scopes information
          await this.#prismaClient.apiConnection.updateMany({
            where: {
              dataReferenceId: secretReference.id,
            },
            data: {
              scopes: token.scopes,
              metadata,
            },
          });
        } else {
          secretReference = await this.#prismaClient.secretReference.create({
            data: {
              key,
              provider: env.SECRET_STORE,
            },
          });
        }

        const secretStore = new SecretStore(env.SECRET_STORE);
        await secretStore.setSecret(key, token);

        //if there's an expiry, we want to add it to the connection so we can easily run a background job against it
        const expiresAt = this.#getExpiresAtFromToken({ token });

        const createConnectionWithSlug = async (
          appendRandom = false,
          attempt = 0
        ): Promise<ApiConnection> => {
          let slug = createSlug(title);

          if (appendRandom) {
            slug = `${slug}-${randomGenerator()}`;
          }

          if (!secretReference) {
            throw new Error(
              `Unable to create secret reference for key ${key} and provider ${env.SECRET_STORE}`
            );
          }

          try {
            return await this.#prismaClient.apiConnection.create({
              data: {
                organizationId: organizationId,
                apiIdentifier,
                authenticationMethodKey,
                metadata,
                title,
                dataReferenceId: secretReference.id,
                scopes: token.scopes,
                expiresAt,
                slug,
              },
            });
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "P2002" &&
              attempt < 24
            ) {
              return await createConnectionWithSlug(true, attempt + 1);
            }

            throw error;
          }
        };

        const connection = await createConnectionWithSlug();

        //schedule refreshing the token
        await this.#scheduleRefresh(expiresAt, connection);

        return connection;
      }
    }
  }

  async refreshConnection({ connectionId }: { connectionId: string }) {
    const connection = await this.#prismaClient.apiConnection.findUnique({
      where: {
        id: connectionId,
      },
      include: {
        dataReference: true,
      },
    });

    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const api = this.#apiStore.getApi(connection.apiIdentifier);
    if (!api) {
      throw new Error(`API ${connection.apiIdentifier} not found`);
    }

    const authenticationMethod =
      api.authenticationMethods[connection.authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${connection.authenticationMethodKey} not found for API ${connection.apiIdentifier}`
      );
    }

    switch (authenticationMethod.type) {
      case "oauth2": {
        const getClientConfig = getClientConfigFromEnv(
          authenticationMethod.client.id.envName,
          authenticationMethod.client.secret.envName
        );
        const callbackHostName = this.#callbackUrl(authenticationMethod);

        const secretStore = new SecretStore(
          connection.dataReference.provider as SecretStoreProvider
        );
        const accessToken = await secretStore.getSecret(
          AccessTokenSchema,
          connection.dataReference.key
        );

        if (!accessToken) {
          throw new Error(
            `Access token not found for connection ${connectionId} with key ${connection.dataReference.key}`
          );
        }

        if (!accessToken.refreshToken) {
          throw new Error(
            `Refresh token not found for connection ${connectionId} with key ${connection.dataReference.key}`
          );
        }

        if (!accessToken.expiresIn) {
          throw new Error(
            `Expires in not found for connection ${connectionId} with key ${connection.dataReference.key}`
          );
        }

        const params: RefreshTokenParams = {
          refreshUrl: authenticationMethod.config.refresh.url,
          clientId: getClientConfig.id,
          clientSecret: getClientConfig.secret,
          callbackUrl: `${callbackHostName}/resources/connection/oauth2/callback`,
          requestedScopes: connection.scopes,
          scopeSeparator:
            authenticationMethod.config.authorization.scopeSeparator,
          token: {
            accessToken: accessToken.accessToken,
            refreshToken: accessToken.refreshToken,
            expiresAt: new Date(
              connection.updatedAt.getTime() + accessToken.expiresIn * 1000
            ),
          },
          accessTokenKey:
            authenticationMethod.config.token.accessTokenKey ?? "access_token",
          refreshTokenKey:
            authenticationMethod.config.token.refreshTokenKey ??
            "refresh_token",
          expiresInKey:
            authenticationMethod.config.token.expiresInKey ?? "expires_in",
          scopeKey: authenticationMethod.config.token.scopeKey ?? "scope",
        };

        //todo do we need pkce here?
        const token = await (authenticationMethod.config.refresh.refreshToken
          ? authenticationMethod.config.refresh.refreshToken(params)
          : refreshOAuth2Token(params));

        //update the secret
        await secretStore.setSecret(connection.dataReference.key, token);

        //update the connection
        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod,
        });

        const expiresAt = this.#getExpiresAtFromToken({ token });
        const newConnection = await this.#prismaClient.apiConnection.update({
          where: {
            id: connectionId,
          },
          data: {
            metadata,
            scopes: token.scopes,
            expiresAt,
          },
          include: {
            dataReference: true,
          },
        });

        await this.#scheduleRefresh(expiresAt, connection);
        return newConnection;
      }
    }
  }

  /** Get credentials for the ApiConnection */
  async getCredentials(connection: ApiConnectionWithSecretReference) {
    //refresh the token if the expiry is in the past (or about to be)
    if (connection.expiresAt) {
      const refreshBy = new Date(
        connection.expiresAt.getTime() - tokenRefreshThreshold * 1000
      );
      if (refreshBy < new Date()) {
        connection = await this.refreshConnection({
          connectionId: connection.id,
        });
      }
    }

    const secretStore = new SecretStore(
      connection.dataReference.provider as SecretStoreProvider
    );
    return secretStore.getSecret(
      AccessTokenSchema,
      connection.dataReference.key
    );
  }

  #enrichConnection(connection: ApiConnection) {
    //parse the metadata into the desired format, fallback if needed
    const parsedMetadata = ConnectionMetadataSchema.safeParse(
      connection.metadata
    );
    let metadata: ConnectionMetadata = {};
    if (parsedMetadata.success) {
      metadata = parsedMetadata.data;
    } else {
      console.warn(
        `Connection ${
          connection.id
        } has invalid metadata, falling back to empty metadata.\n${parsedMetadata.error.format()}`
      );
    }

    //add details about the API and authentication method
    const api = this.#apiStore.getApi(connection.apiIdentifier);
    if (!api) {
      throw new Error(
        `API ${connection.apiIdentifier} not found for connection ${connection.id}`
      );
    }

    const authenticationMethod =
      api.authenticationMethods[connection.authenticationMethodKey];
    if (!authenticationMethod) {
      throw new Error(
        `API authentication method ${connection.authenticationMethodKey} not found for API ${connection.apiIdentifier} for connection ${connection.id}`
      );
    }

    return {
      ...connection,
      metadata,
      api: {
        identifier: api.identifier,
        name: api.name,
      },
      authenticationMethod: {
        type: authenticationMethod.type,
        possibleScopes: authenticationMethod.scopes,
      },
    };
  }

  #callbackUrl(authenticationMethod: APIAuthenticationMethodOAuth2) {
    return authenticationMethod.config.appHostEnvName
      ? process.env[authenticationMethod.config.appHostEnvName]
      : env.APP_ORIGIN;
  }

  #getMetadataFromToken({
    authenticationMethod,
    token,
  }: {
    authenticationMethod: APIAuthenticationMethodOAuth2;
    token: AccessToken;
  }) {
    const metadata: ConnectionMetadata = {};
    if (authenticationMethod.config.token.metadata.accountPointer) {
      const accountPointer = jsonpointer.compile(
        authenticationMethod.config.token.metadata.accountPointer
      );
      const account = accountPointer.get(token.raw);
      if (typeof account === "string") {
        metadata.account = account;
      }
    }

    return metadata;
  }

  #getExpiresAtFromToken({ token }: { token: AccessToken }) {
    if (token.expiresIn) {
      return new Date(new Date().getTime() + token.expiresIn * 1000);
    }
    return undefined;
  }

  async #scheduleRefresh(
    expiresAt: Date | undefined,
    connection: ApiConnection
  ) {
    if (expiresAt) {
      await workerQueue.enqueue(
        "refreshOAuthToken",
        {
          organizationId: connection.organizationId,
          connectionId: connection.id,
        },
        {
          //attempt refreshing 5 minutes before the token expires
          runAt: new Date(expiresAt.getTime() - tokenRefreshThreshold * 1000),
        }
      );
    }
  }
}

export const apiConnectionRepository = new APIAuthenticationRepository();
