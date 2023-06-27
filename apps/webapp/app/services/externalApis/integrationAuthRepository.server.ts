import type {
  SecretReference,
  ExternalAccount,
  IntegrationConnection,
  ConnectionType,
  Integration,
  ConnectionAttempt,
  IntegrationAuthMethod,
  IntegrationDefinition,
} from "@trigger.dev/database";
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
  ApiAuthenticationMethod,
  ApiAuthenticationMethodOAuth2,
  ConnectionMetadata,
  GrantTokenParams,
  OAuthClient,
  OAuthClientSchema,
  RefreshTokenParams,
} from "./types";
import { AccessTokenSchema } from "./types";

export type ConnectionWithSecretReference = IntegrationConnection & {
  dataReference: SecretReference;
};

const randomGenerator = customAlphabet("1234567890abcdef", 3);

/** How many seconds before expiry we should refresh the token  */
const tokenRefreshThreshold = 5 * 60;

export class IntegrationAuthRepository {
  #integrationCatalog: IntegrationCatalog;
  #prismaClient: PrismaClient;

  constructor(
    catalog: IntegrationCatalog = integrationCatalog,
    prismaClient: PrismaClient = prisma
  ) {
    this.#integrationCatalog = catalog;
    this.#prismaClient = prismaClient;
  }

  /** Get all API connections for the organization, for a specific API */
  async getClientsForIntegration(organizationId: string, identifier: string) {
    const clients = await this.#prismaClient.integration.findMany({
      where: {
        organizationId: organizationId,
        definitionId: identifier,
      },
      include: {
        authMethod: true,
        definition: true,
      },
    });

    return clients.map((c) =>
      this.#enrichIntegration(c, c.definition, c.authMethod)
    );
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
    clientType: ConnectionType;
    scopes: string[];
    title: string;
    description?: string;
    redirectTo: string;
    url: URL;
  }): Promise<string> {
    //creates a client and retries if it fails
    const createClientWithSlug = async (
      tx: PrismaTransactionClient,
      customClientReference: SecretReference | undefined,
      appendRandom = false,
      attemptCount = 0
    ): Promise<Integration> => {
      let slug = createSlug(title);

      if (appendRandom) {
        slug = `${slug}-${randomGenerator()}`;
      }

      try {
        return await tx.integration.create({
          data: {
            id,
            connectionType: clientType,
            scopes,
            title,
            slug,
            authSource: "HOSTED",
            description,
            customClientReference: customClientReference
              ? {
                  connect: {
                    id: customClientReference.id,
                  },
                }
              : undefined,
            organization: {
              connect: {
                id: organizationId,
              },
            },
            authMethod: {
              connect: {
                definitionId_key: {
                  definitionId: integrationIdentifier,
                  key: integrationAuthMethod,
                },
              },
            },
            definition: {
              connect: {
                id: integrationIdentifier,
              },
            },
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
            tx,
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
        tx,
        integration: client,
        customOAuthClient: customClient,
        redirectTo,
        url,
      });
    });
  }

  async createConnectionAttempt({
    tx,
    integration,
    customOAuthClient,
    redirectTo,
    url,
  }: {
    tx: PrismaTransactionClient;
    integration: Integration;
    customOAuthClient?: OAuthClient;
    redirectTo: string;
    url: URL;
  }) {
    const { authMethod } = await this.#getDefinitionAndAuthMethod(integration);

    switch (authMethod.type) {
      case "oauth2": {
        let pkceCode: string | undefined = undefined;
        if (authMethod.config.pkce !== false) {
          pkceCode = crypto.randomBytes(24).toString("hex");
        }

        //create a connection attempt
        const connectionAttempt = await tx.connectionAttempt.create({
          data: {
            integrationId: integration.id,
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
          authenticationMethod: authMethod as ApiAuthenticationMethodOAuth2,
          url,
          hasCustomClient: !!customOAuthClient,
          clientId: integration.id,
        });

        const createAuthorizationParams = {
          authorizationUrl: authMethod.config.authorization.url,
          clientId: clientConfig.id,
          clientSecret: clientConfig.secret,
          key: connectionAttempt.id,
          callbackUrl,
          scopeParamName:
            authMethod.config.authorization.scopeParamName ?? "scope",
          scopes: integration.scopes,
          scopeSeparator: authMethod.config.authorization.scopeSeparator,
          pkceCode,
          authorizationLocation:
            authMethod.config.authorization.authorizationLocation ?? "body",
          extraParameters: authMethod.config.authorization.extraParameters,
        };

        const authorizationUrl = await createOAuth2Url(
          createAuthorizationParams,
          authMethod.config.authorization.createUrlStrategy
        );

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
    attempt: ConnectionAttempt & { integration: Integration };
    code: string;
    url: URL;
    customOAuthClient?: OAuthClient;
  }) {
    const { definition, authMethod } = await this.#getDefinitionAndAuthMethod(
      attempt.integration
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
          authenticationMethod: authMethod as ApiAuthenticationMethodOAuth2,
          url,
          hasCustomClient: !!customOAuthClient,
          clientId: attempt.integration.id,
        });

        const params: GrantTokenParams = {
          tokenUrl: authMethod.config.token.url,
          clientId: clientConfig.id,
          clientSecret: clientConfig.secret,
          code,
          callbackUrl,
          requestedScopes: attempt.integration.scopes,
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

        const token = await grantOAuth2Token(
          params,
          authMethod.config.token.grantTokenStrategy
        );

        //this key is used to store in the relevant SecretStore
        const hashedAccessToken = crypto
          .createHash("sha256")
          .update(token.accessToken)
          .digest("base64");

        const key = secretStoreKeyForToken(
          definition.identifier,
          hashedAccessToken
        );

        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod: authMethod as ApiAuthenticationMethodOAuth2,
        });

        return await this.#prismaClient.$transaction(async (tx) => {
          let secretReference = await tx.secretReference.findUnique({
            where: {
              key,
            },
          });

          if (secretReference) {
            //if the secret reference already exists, update existing connections with the new scopes information
            await tx.integrationConnection.updateMany({
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

          const connection = await tx.integrationConnection.create({
            data: {
              organizationId: attempt.integration.organizationId,
              integrationId: attempt.integration.id,
              metadata,
              dataReferenceId: secretReference.id,
              scopes: token.scopes,
              expiresAt,
            },
          });

          await workerQueue.enqueue(
            "connectionCreated",
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
    integration,
    externalAccount,
  }: {
    token: AccessToken;
    integration: Integration;
    externalAccount?: ExternalAccount;
  }) {
    const { definition, authMethod } = await this.#getDefinitionAndAuthMethod(
      integration
    );

    switch (authMethod.type) {
      case "oauth2": {
        //this key is used to store in the relevant SecretStore
        const hashedAccessToken = crypto
          .createHash("sha256")
          .update(token.accessToken)
          .digest("base64");

        const key = secretStoreKeyForToken(
          definition.identifier,
          hashedAccessToken
        );

        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod: authMethod as ApiAuthenticationMethodOAuth2,
        });

        return await this.#prismaClient.$transaction(async (tx) => {
          let secretReference = await tx.secretReference.findUnique({
            where: {
              key,
            },
          });

          if (secretReference) {
            //if the secret reference already exists, update existing connections with the new scopes information
            await tx.integrationConnection.updateMany({
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

          const connection = await tx.integrationConnection.create({
            data: {
              organizationId: integration.organizationId,
              integrationId: integration.id,
              metadata,
              dataReferenceId: secretReference.id,
              scopes: token.scopes,
              expiresAt,
              externalAccountId: externalAccount?.id,
              connectionType: externalAccount ? "EXTERNAL" : "DEVELOPER",
            },
          });

          await workerQueue.enqueue(
            "connectionCreated",
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
    const connection =
      await this.#prismaClient.integrationConnection.findUnique({
        where: {
          id: connectionId,
        },
        include: {
          dataReference: true,
          integration: {
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
    if (connection.integration.customClientReference) {
      const secretStore = getSecretStore(env.SECRET_STORE);
      customOAuthClient = await secretStore.getSecret(
        OAuthClientSchema,
        connection.integration.customClientReference.key
      );
    }

    const { authMethod } = await this.#getDefinitionAndAuthMethod(
      connection.integration
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
          requestedScopes: connection.integration.scopes,
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
        const token = await refreshOAuth2Token(
          params,
          authMethod.config.refresh.refreshTokenStrategy
        );

        //update the secret
        await secretStore.setSecret(connection.dataReference.key, token);

        //update the connection
        const metadata = this.#getMetadataFromToken({
          token,
          authenticationMethod: authMethod as ApiAuthenticationMethodOAuth2,
        });

        const expiresAt = this.#getExpiresAtFromToken({ token });
        const newConnection =
          await this.#prismaClient.integrationConnection.update({
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
      default: {
        throw new Error(
          `Authentication method type ${authMethod.type} not supported`
        );
      }
    }
  }

  /** Get credentials for the ApiConnection */
  async getCredentials(connection: ConnectionWithSecretReference) {
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

  #enrichIntegration(
    integration: Integration,
    definition: IntegrationDefinition,
    authMethod?: IntegrationAuthMethod | null
  ) {
    if (!authMethod) {
      throw new Error(
        `Auth method ${integration.authMethodId} not found for integration ${definition.id}`
      );
    }

    if (authMethod.type !== "oauth2") {
      throw new Error(
        `Authentication method type ${authMethod.type} not supported`
      );
    }

    return {
      ...integration,
      definition: {
        identifier: definition.id,
        name: definition.name,
      },
      authMethod: {
        type: authMethod.type,
        name: authMethod.name,
        possibleScopes: authMethod.scopes,
      },
    };
  }

  async #getDefinitionAndAuthMethod(integration: Integration) {
    const definition =
      await this.#prismaClient.integrationDefinition.findUniqueOrThrow({
        where: {
          id: integration.definitionId,
        },
      });

    const authMethod = integration.authMethodId
      ? await this.#prismaClient.integrationAuthMethod.findUniqueOrThrow({
          where: {
            id: integration.authMethodId,
          },
        })
      : undefined;

    if (!authMethod) {
      throw new Error(
        `Auth method ${integration.authMethodId} not found for integration ${definition.id}`
      );
    }

    return {
      definition: {
        identifier: definition.id,
        name: definition.name,
      },
      authMethod: {
        name: authMethod.name,
        description: authMethod.description,
        type: authMethod.type,
        client: authMethod.client as ApiAuthenticationMethodOAuth2["client"],
        config: authMethod.config as ApiAuthenticationMethodOAuth2["config"],
        scopes: authMethod.scopes as ApiAuthenticationMethodOAuth2["scopes"],
      },
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
        ? process.env[authenticationMethod.config.appHostEnvName] ?? url
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
    connection: IntegrationConnection,
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

export const integrationAuthRepository = new IntegrationAuthRepository();
