import { WebClient } from "@slack/web-api";
import {
  IntegrationService,
  Organization,
  OrganizationIntegration,
  SecretReference,
} from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";

const SlackSecretSchema = z.object({
  botAccessToken: z.string(),
  userAccessToken: z.string().optional(),
  expiresIn: z.number().optional(),
  refreshToken: z.string().optional(),
  botScopes: z.array(z.string()).optional(),
  userScopes: z.array(z.string()).optional(),
  raw: z.record(z.any()).optional(),
});

type SlackSecret = z.infer<typeof SlackSecretSchema>;

const REDIRECT_AFTER_AUTH_KEY = "redirect-back-after-auth";

export type OrganizationIntegrationForService<TService extends IntegrationService> = Omit<
  AuthenticatableIntegration,
  "service"
> & {
  service: TService;
};

type AuthenticatedClientOptions<TService extends IntegrationService> = TService extends "SLACK"
  ? {
      forceBotToken?: boolean;
    }
  : undefined;

type AuthenticatedClientForIntegration<TService extends IntegrationService> =
  TService extends "SLACK" ? InstanceType<typeof WebClient> : never;

export type AuthenticatableIntegration = OrganizationIntegration & {
  tokenReference: SecretReference;
};

export function isIntegrationForService<TService extends IntegrationService>(
  integration: AuthenticatableIntegration,
  service: TService
): integration is OrganizationIntegrationForService<TService> {
  return (integration.service satisfies IntegrationService) === service;
}

export class OrgIntegrationRepository {
  static async getAuthenticatedClientForIntegration<TService extends IntegrationService>(
    integration: OrganizationIntegrationForService<TService>,
    options?: AuthenticatedClientOptions<TService>
  ): Promise<AuthenticatedClientForIntegration<TService>> {
    const secretStore = getSecretStore(integration.tokenReference.provider);

    switch (integration.service) {
      case "SLACK": {
        const secret = await secretStore.getSecret(
          SlackSecretSchema,
          integration.tokenReference.key
        );

        if (!secret) {
          throw new Error("Failed to get access token");
        }

        // TODO refresh access token here
        return new WebClient(
          options?.forceBotToken
            ? secret.botAccessToken
            : secret.userAccessToken ?? secret.botAccessToken,
          {
            retryConfig: {
              retries: 2,
              randomize: true,
              maxTimeout: 5000,
              maxRetryTime: 10000,
            },
          }
        ) as AuthenticatedClientForIntegration<TService>;
      }
      default: {
        throw new Error(`Unsupported service ${integration.service}`);
      }
    }
  }

  static isSlackSupported =
    !!env.ORG_SLACK_INTEGRATION_CLIENT_ID && !!env.ORG_SLACK_INTEGRATION_CLIENT_SECRET;

  static isVercelSupported =
    !!env.VERCEL_INTEGRATION_CLIENT_ID && !!env.VERCEL_INTEGRATION_CLIENT_SECRET && !!env.VERCEL_INTEGRATION_APP_SLUG;

  /**
   * Generate the URL to install the Vercel integration.
   * Users are redirected to Vercel's marketplace to complete the installation.
   *
   * @param state - Base64-encoded state containing org/project info for the callback
   */
  static vercelInstallUrl(state: string): string {
    // The user goes to Vercel's marketplace to install the integration
    // After installation, Vercel redirects to our callback with the authorization code
    const redirectUri = encodeURIComponent(`${env.APP_ORIGIN}/vercel/callback`);
    const encodedState = encodeURIComponent(state);
    return `https://vercel.com/integrations/${env.VERCEL_INTEGRATION_APP_SLUG}/new?state=${encodedState}&redirect_uri=${redirectUri}`;
  }

  static slackAuthorizationUrl(
    state: string,
    scopes: string[] = [
      "channels:read",
      "groups:read",
      "im:read",
      "mpim:read",
      "chat:write",
      "chat:write.public",
    ],
    userScopes: string[] = ["channels:read", "groups:read", "im:read", "mpim:read", "chat:write"]
  ) {
    return `https://slack.com/oauth/v2/authorize?client_id=${
      env.ORG_SLACK_INTEGRATION_CLIENT_ID
    }&scope=${scopes.join(",")}&user_scope=${userScopes.join(",")}&state=${state}&redirect_uri=${
      env.APP_ORIGIN
    }/integrations/slack/callback`;
  }

  static async redirectToAuthService(
    service: IntegrationService,
    state: string,
    request: Request,
    redirectTo: string
  ) {
    const session = await getUserSession(request);
    session.set(REDIRECT_AFTER_AUTH_KEY, redirectTo);

    const authUrl = service === "SLACK" ? this.slackAuthorizationUrl(state) : undefined;

    if (!authUrl) {
      throw new Response("Unsupported service", { status: 400 });
    }

    logger.debug("Redirecting to auth service", {
      service,
      authUrl,
      redirectTo,
    });

    return new Response(null, {
      status: 302,
      headers: {
        location: authUrl,
        "Set-Cookie": await commitSession(session),
      },
    });
  }

  static async redirectAfterAuth(request: Request) {
    const session = await getUserSession(request);

    logger.debug("Redirecting back after auth", {
      sessionData: session.data,
    });

    const redirectTo = session.get(REDIRECT_AFTER_AUTH_KEY);

    if (!redirectTo) {
      throw new Response("Invalid redirect", { status: 400 });
    }

    session.unset(REDIRECT_AFTER_AUTH_KEY);

    return new Response(null, {
      status: 302,
      headers: {
        location: redirectTo,
        "Set-Cookie": await commitSession(session),
      },
    });
  }

  static async createOrgIntegration(serviceName: string, code: string, org: Organization) {
    switch (serviceName) {
      case "slack": {
        if (!env.ORG_SLACK_INTEGRATION_CLIENT_ID || !env.ORG_SLACK_INTEGRATION_CLIENT_SECRET) {
          throw new Error("Slack integration not configured");
        }

        const client = new WebClient();

        const result = await client.oauth.v2.access({
          client_id: env.ORG_SLACK_INTEGRATION_CLIENT_ID,
          client_secret: env.ORG_SLACK_INTEGRATION_CLIENT_SECRET,
          code,
          redirect_uri: `${env.APP_ORIGIN}/integrations/slack/callback`,
        });

        if (result.ok) {
          logger.debug("Received slack access token", {
            result,
          });

          if (!result.access_token) {
            throw new Error("Failed to get access token");
          }

          return await $transaction(prisma, async (tx) => {
            const secretStore = getSecretStore("DATABASE", {
              prismaClient: tx,
            });

            const integrationFriendlyId = generateFriendlyId("org_integration");

            const secretValue: SlackSecret = {
              botAccessToken: result.access_token!,
              userAccessToken: result.authed_user ? result.authed_user.access_token : undefined,
              expiresIn: result.expires_in,
              refreshToken: result.refresh_token,
              botScopes: result.scope ? result.scope.split(",") : [],
              userScopes: result.authed_user?.scope ? result.authed_user.scope.split(",") : [],
              raw: result,
            };

            logger.debug("Setting secret", {
              secretValue,
            });

            await secretStore.setSecret(integrationFriendlyId, secretValue);

            const reference = await tx.secretReference.create({
              data: {
                provider: "DATABASE",
                key: integrationFriendlyId,
              },
            });

            return await tx.organizationIntegration.create({
              data: {
                friendlyId: integrationFriendlyId,
                organizationId: org.id,
                service: "SLACK",
                tokenReferenceId: reference.id,
                integrationData: {
                  team: result.team,
                  user: result.authed_user
                    ? {
                        id: result.authed_user.id,
                      }
                    : undefined,
                } as any,
              },
            });
          });
        }
      }
      default: {
        throw new Error(`Service ${serviceName} not supported`);
      }
    }
  }
}
