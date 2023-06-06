import type {
  ApiConnection,
  ApiConnectionAttempt,
  ApiConnectionClient,
  SecretReference,
  ExternalAccount,
} from ".prisma/client";
import jsonpointer from "jsonpointer";
import { customAlphabet } from "nanoid";
import * as crypto from "node:crypto";
import createSlug from "slug";
import type {
  PrismaClient,
  PrismaClientOrTransaction,
  PrismaTransactionClient,
} from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { workerQueue } from "~/services/worker.server";
import { getSecretStore } from "../secrets/secretStore.server";
import type { IntegrationCatalog } from "./integrationCatalog.server";
import { integrationCatalog } from "./integrationCatalog.server";
import {
  createOAuth2Url,
  getClientConfig,
  grantOAuth2Token,
  refreshOAuth2Token,
} from "./oauth2.server";
import {
  AccessToken,
  ApiAuthenticationMethodOAuth2,
  ConnectionMetadata,
  GrantTokenParams,
  OAuthClient,
  OAuthClientSchema,
  RefreshTokenParams,
} from "./types";
import { AccessTokenSchema } from "./types";
import { CreateExternalConnectionBody } from "@/../../packages/internal/src";
import { ApiConnectionType } from "~/models/apiConnection.server";

export type ApiConnectionWithSecretReference = ApiConnection & {
  dataReference: SecretReference;
};

const randomGenerator = customAlphabet("1234567890abcdef", 3);

/** How many seconds before expiry we should refresh the token  */
const tokenRefreshThreshold = 5 * 60;

export class APIAuthenticationRepository {
  #integrationCatalog: IntegrationCatalog;
  #prismaClient: PrismaClient;

  constructor(
    catalog: IntegrationCatalog = integrationCatalog,
    prismaClient: PrismaClient = prisma
  ) {
    this.#integrationCatalog = catalog;
    this.#prismaClient = prismaClient;
  }

  /** Get all API clients for the organization */
  async getAllClients(organizationId: string) {
    const clients = await this.#prismaClient.apiConnectionClient.findMany({
      where: {
        organizationId: organizationId,
      },
      orderBy: {
        title: "asc",
      },
    });

    return clients.map((c) => this.#enrichClient(c));
  }

  /** Get all API connections for the organization, for a specific API */
  async getClientsForIntegration(organizationId: string, identifier: string) {
    const clients = await this.#prismaClient.apiConnectionClient.findMany({
      where: {
        organizationId: organizationId,
        integrationIdentifier: identifier,
      },
    });

    return clients.map((c) => this.#enrichClient(c));
  }

  async createConnectionClient({
    id,
    customClient,
    organizationId,
    integrationIdentifier,
    integrationAuthMethod,
    clientType,
    scopes,
    title,
    description,
    url,
    redirectTo,
  }: {
    id: string;
    customClient?: OAuthClient;
    organizationId: string;
    integrationIdentifier: string;
    integrationAuthMethod: string;
    clientType: ApiConnectionType;
    scopes: string[];
    title: string;
    description?: string;
    redirectTo: string;
    url: URL;
  }): Promise<string> {
    //creates a client and retries if it fails
    const createClientWithSlug = async (
      transactionClient: PrismaTransactionClient,
      customClientReference: SecretReference | undefined,
      appendRandom = false,
      attemptCount = 0
    ): Promise<ApiConnectionClient> => {
      let slug = createSlug(title);

      if (appendRandom) {
        slug = `${slug}-${randomGenerator()}`;
      }

      try {
        return await transactionClient.apiConnectionClient.create({
          data: {
            id,
            organizationId,
            clientType,
            scopes,
            title,
            slug,
            integrationIdentifier,
            integrationAuthMethod,
            description,
            customClientReferenceId: customClientReference?.id,
          },
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002" &&
          attemptCount < 24
        ) {
          return await createClientWithSlug(
            transactionClient,
            customClientReference,
            true,
            attemptCount + 1
          );
        }

        throw error;
      }
    };

    return this.#prismaClient.$transaction(async (tx) => {
      let customClientReference: SecretReference | undefined = undefined;
      //if there's a custom client, we need to save the details to the secret store
      if (customClient) {
        const key = `connectionClient/customClient/${id}`;

        const secretStore = getSecretStore(env.SECRET_STORE, {
          prismaClient: tx,
        });

        await secretStore.setSecret(key, { ...customClient });

        customClientReference = await tx.secretReference.create({
          data: {
            key,
            provider: env.SECRET_STORE,
          },
        });
      }

      const client = await createClientWithSlug(tx, customClientReference);

      return await this.createConnectionAttempt({
        transactionClient: tx,
        client,
        customOAuthClient: customClient,
        redirectTo,
        url,
      });
    });
  }

  async createConnectionAttempt({
    transactionClient,
    client,
    customOAuthClient,
    redirectTo,
    url,
  }: {
    transactionClient: PrismaTransactionClient;
    client: ApiConnectionClient;
    customOAuthClient?: OAuthClient;
    redirectTo: string;
    url: URL;
  }) {
    const { authMethod } = this.#getIntegrationAndAuthMethod(client);

    switch (authMethod.type) {
      case "oauth2": {
        let pkceCode: string | undefined = undefined;
        if (authMethod.config.pkce !== false) {
          pkceCode = crypto.randomBytes(24).toString("hex");
        }

        //create a connection attempt
        const connectionAttempt =
          await transactionClient.apiConnectionAttempt.create({
            data: {
              clientId: client.id,
              redirectTo,
              securityCode: pkceCode,
            },
          });

        //get the client config, custom client or from env vars
        const clientConfig = getClientConfig({
          env: {
            idName: authMethod.client.id.envName,
            secretName: authMethod.client.secret.envName,
          },
          customOAuthClient,
        });
        const callbackUrl = this.#buildCallbackUrl({
          authenticationMethod: authMethod,
          url,
          hasCustomClient: !!customOAuthClient,
          clientId: client.id,
        });

        const createAuthorizationParams = {
          authorizationUrl: authMethod.config.authorization.url,
          clientId: clientConfig.id,
          clientSecret: clientConfig.secret,
          key: connectionAttempt.id,
          callbackUrl,
          scopeParamName:
            authMethod.config.authorization.scopeParamName ?? "scope",
          scopes: client.scopes,
          scopeSeparator: authMethod.config.authorization.scopeSeparator,
          pkceCode,
          authorizationLocation:
            authMethod.config.authorization.authorizationLocation ?? "body",
          extraParameters: authMethod.config.authorization.extraParameters,
        };

        const authorizationUrl = await (authMethod.config.authorization
          .createUrl
          ? authMethod.config.authorization.createUrl(createAuthorizationParams)
          : createOAuth2Url(createAuthorizationParams));

        return authorizationUrl;
      }
      default: {
        throw new Error(
          `Authentication method type ${authMethod.type} not supported`
        );
      }
    }
  }

  async createConnectionFromAttempt({
    attempt,
    code,
    url,
    customOAuthClient,
  }: {
    attempt: ApiConnectionAttempt & { client: ApiConnectionClient };
    code: string;
    url: URL;
    customOAuthClient?: OAuthClient;
  }) {
    const { integration, authMethod } = this.#getIntegrationAndAuthMethod(
      attempt.client
    );

    switch (authMethod.type) {
      case "oauth2": {
        const clientConfig = getClientConfig({
          env: {
            idName: authMethod.client.id.envName,
            secretName: authMethod.client.secret.envName,
          },
          customOAuthClient,
        });
        const callbackUrl = this.#buildCallbackUrl({
          authenticationMethod: authMethod,
          url,
          hasCustomClient: !!customOAuthClient,
          clientId: attempt.client.id,
        });

        const params: GrantTokenParams = {
          tokenUrl: authMethod.config.token.url,
          clientId: clientConfig.id,
          clientSecret: clientConfig.secret,
          code,
          callbackUrl,
          requestedScopes: attempt.client.scopes,
          scopeSeparator: authMethod.config.authorization.scopeSeparator,
          pkceCode: attempt.securityCode ?? undefined,
          accessTokenPointer:
            authMethod.config.token.accessTokenPointer ?? "/access_token",
          refreshTokenPointer:
            authMethod.config.token.refreshTokenPointer ?? "/refresh_token",
          expiresInPointer:
            authMethod.config.token.expiresInPointer ?? "/expires_in",
          scopePointer: authMethod.config.token.scopePointer ?? "/scope",
        };

        const token = await (authMethod.config.token.grantToken
          ? authMethod.config.token.grantToken(params)
          : grantOAuth2Token(params));

        //this key is used to store in the relevant SecretStore
        const hashedAccessToken = crypto
          .createHash("sha256")
          .update(token.accessToken)
          .digest("base64");

        const key = secretStoreKeyForToken(
          integration.identifier,
          hashedAccessToken
        );

        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod: authMethod,
        });

        return await this.#prismaClient.$transaction(async (tx) => {
          let secretReference = await tx.secretReference.findUnique({
            where: {
              key,
            },
          });

          if (secretReference) {
            //if the secret reference already exists, update existing connections with the new scopes information
            await tx.apiConnection.updateMany({
              where: {
                dataReferenceId: secretReference.id,
              },
              data: {
                scopes: token.scopes,
                metadata,
              },
            });
          } else {
            secretReference = await tx.secretReference.create({
              data: {
                key,
                provider: env.SECRET_STORE,
              },
            });
          }

          const secretStore = getSecretStore(env.SECRET_STORE, {
            prismaClient: tx,
          });

          await secretStore.setSecret(key, token);

          //if there's an expiry, we want to add it to the connection so we can easily run a background job against it
          const expiresAt = this.#getExpiresAtFromToken({ token });

          const connection = await tx.apiConnection.create({
            data: {
              organizationId: attempt.client.organizationId,
              clientId: attempt.client.id,
              metadata,
              dataReferenceId: secretReference.id,
              scopes: token.scopes,
              expiresAt,
            },
          });

          await workerQueue.enqueue(
            "apiConnectionCreated",
            {
              id: connection.id,
            },
            { tx }
          );

          //schedule refreshing the token
          await this.#scheduleRefresh(expiresAt, connection, tx);

          return connection;
        });
      }
    }
  }

  async createConnectionFromToken({
    token,
    client,
    externalAccount,
  }: {
    token: AccessToken;
    client: ApiConnectionClient;
    externalAccount?: ExternalAccount;
  }) {
    const { integration, authMethod } =
      this.#getIntegrationAndAuthMethod(client);

    switch (authMethod.type) {
      case "oauth2": {
        //this key is used to store in the relevant SecretStore
        const hashedAccessToken = crypto
          .createHash("sha256")
          .update(token.accessToken)
          .digest("base64");

        const key = secretStoreKeyForToken(
          integration.identifier,
          hashedAccessToken
        );

        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod: authMethod,
        });

        return await this.#prismaClient.$transaction(async (tx) => {
          let secretReference = await tx.secretReference.findUnique({
            where: {
              key,
            },
          });

          if (secretReference) {
            //if the secret reference already exists, update existing connections with the new scopes information
            await tx.apiConnection.updateMany({
              where: {
                dataReferenceId: secretReference.id,
              },
              data: {
                scopes: token.scopes,
                metadata,
              },
            });
          } else {
            secretReference = await tx.secretReference.create({
              data: {
                key,
                provider: env.SECRET_STORE,
              },
            });
          }

          const secretStore = getSecretStore(env.SECRET_STORE, {
            prismaClient: tx,
          });

          await secretStore.setSecret(key, token);

          //if there's an expiry, we want to add it to the connection so we can easily run a background job against it
          const expiresAt = this.#getExpiresAtFromToken({ token });

          const connection = await tx.apiConnection.create({
            data: {
              organizationId: client.organizationId,
              clientId: client.id,
              metadata,
              dataReferenceId: secretReference.id,
              scopes: token.scopes,
              expiresAt,
              externalAccountId: externalAccount?.id,
              connectionType: externalAccount ? "EXTERNAL" : "DEVELOPER",
            },
          });

          await workerQueue.enqueue(
            "apiConnectionCreated",
            {
              id: connection.id,
            },
            { tx }
          );

          //schedule refreshing the token
          await this.#scheduleRefresh(expiresAt, connection, tx);

          return connection;
        });
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
        client: {
          include: {
            customClientReference: true,
          },
        },
      },
    });

    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    let customOAuthClient: OAuthClient | undefined;
    if (connection.client.customClientReference) {
      const secretStore = getSecretStore(env.SECRET_STORE);
      customOAuthClient = await secretStore.getSecret(
        OAuthClientSchema,
        connection.client.customClientReference.key
      );
    }

    const { authMethod } = this.#getIntegrationAndAuthMethod(connection.client);

    switch (authMethod.type) {
      case "oauth2": {
        const clientConfig = getClientConfig({
          env: {
            idName: authMethod.client.id.envName,
            secretName: authMethod.client.secret.envName,
          },
          customOAuthClient,
        });

        const secretStore = getSecretStore(connection.dataReference.provider);
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
          refreshUrl: authMethod.config.refresh.url,
          clientId: clientConfig.id,
          clientSecret: clientConfig.secret,
          requestedScopes: connection.client.scopes,
          scopeSeparator: authMethod.config.authorization.scopeSeparator,
          token: {
            accessToken: accessToken.accessToken,
            refreshToken: accessToken.refreshToken,
            expiresAt: new Date(
              connection.updatedAt.getTime() + accessToken.expiresIn * 1000
            ),
          },
          accessTokenPointer:
            authMethod.config.token.accessTokenPointer ?? "/access_token",
          refreshTokenPointer:
            authMethod.config.token.refreshTokenPointer ?? "/refresh_token",
          expiresInPointer:
            authMethod.config.token.expiresInPointer ?? "/expires_in",
          scopePointer: authMethod.config.token.scopePointer ?? "/scope",
        };

        //todo do we need pkce here?
        const token = await (authMethod.config.refresh.refreshToken
          ? authMethod.config.refresh.refreshToken(params)
          : refreshOAuth2Token(params));

        //update the secret
        await secretStore.setSecret(connection.dataReference.key, token);

        //update the connection
        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod: authMethod,
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

    const secretStore = getSecretStore(connection.dataReference.provider);
    return secretStore.getSecret(
      AccessTokenSchema,
      connection.dataReference.key
    );
  }

  #enrichClient(client: ApiConnectionClient) {
    //add details about the API and authentication method
    const { integration, authMethod } =
      this.#getIntegrationAndAuthMethod(client);

    return {
      ...client,
      integration: {
        identifier: integration.identifier,
        name: integration.name,
      },
      authMethod: {
        type: authMethod.type,
        name: authMethod.name,
        possibleScopes: authMethod.scopes,
      },
    };
  }

  #getIntegrationAndAuthMethod(client: ApiConnectionClient) {
    const integration = this.#integrationCatalog.getIntegration(
      client.integrationIdentifier
    );

    if (!integration) {
      throw new Error(`Integration ${client.integrationIdentifier} not found`);
    }

    const authMethod =
      integration.authenticationMethods[client.integrationAuthMethod];

    if (!authMethod) {
      throw new Error(
        `Integration authentication method ${client.integrationAuthMethod} not found for integration ${client.integrationIdentifier}`
      );
    }

    return {
      integration,
      authMethod,
    };
  }

  #buildCallbackUrl({
    authenticationMethod,
    url,
    hasCustomClient,
    clientId,
  }: {
    authenticationMethod: ApiAuthenticationMethodOAuth2;
    url: URL;
    hasCustomClient: boolean;
    clientId: string;
  }) {
    return new URL(
      `/oauth2/callback`,
      authenticationMethod.config.appHostEnvName
        ? process.env[authenticationMethod.config.appHostEnvName]
        : url
    ).href;
  }

  #getMetadataFromToken({
    authenticationMethod,
    token,
  }: {
    authenticationMethod: ApiAuthenticationMethodOAuth2;
    token: AccessToken;
  }) {
    const metadata: ConnectionMetadata = {};
    if (authenticationMethod.config.token.metadata.accountPointer) {
      const accountPointer = jsonpointer.compile(
        authenticationMethod.config.token.metadata.accountPointer
      );
      const account = accountPointer.get(token.raw ?? {});
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
    connection: ApiConnection,
    tx?: PrismaClientOrTransaction
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
          tx,
        }
      );
    }
  }
}

function secretStoreKeyForToken(
  integrationIdentifier: string,
  hashedAccessToken: string
) {
  return `connection/token/${integrationIdentifier}-${hashedAccessToken}`;
}

export const apiAuthenticationRepository = new APIAuthenticationRepository();
