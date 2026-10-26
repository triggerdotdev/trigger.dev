import {
  isUniqueConstraintError,
  type ProjectAlertChannel,
  type ProjectAlertType,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { env } from "~/env.server";
import { findProjectByRef } from "~/models/project.server";
import {
  decryptSecret,
  EncryptedSecretValueSchema,
  encryptSecret,
} from "~/services/secrets/secretStore.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { type PrismaClientOrTransaction } from "~/db.server";
import { BaseService, ServiceValidationError } from "../baseService.server";
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from "./safeWebhookUrl.server";

export type CreateAlertChannelOptions = {
  name: string;
  alertTypes: ProjectAlertType[];
  environmentTypes: RuntimeEnvironmentType[];
  deduplicationKey?: string;
  authorizedChannel?: { id: string; environmentTypes: RuntimeEnvironmentType[] } | null;
  createOnly?: boolean;
  channel:
    | {
        type: "EMAIL";
        email: string;
      }
    | {
        type: "WEBHOOK";
        url: string;
        secret?: string;
      }
    | {
        type: "SLACK";
        channelId: string;
        channelName: string;
        integrationId: string | undefined;
      };
};

export class AlertChannelChangedError extends Error {
  constructor() {
    super("Alert channel changed, retry");
  }
}

export class CreateAlertChannelService extends BaseService {
  public async call(
    projectRef: string,
    userId: string,
    options: CreateAlertChannelOptions
  ): Promise<ProjectAlertChannel> {
    const project = await findProjectByRef(projectRef, userId);

    if (!project) {
      throw new ServiceValidationError("Project not found");
    }

    // Validate webhook URLs here (not per-route) so every caller is covered.
    // Delivery re-validates at connect time via safeWebhookFetch.
    if (options.channel.type === "WEBHOOK") {
      try {
        await assertSafeWebhookUrl(options.channel.url);
      } catch (error) {
        if (error instanceof UnsafeWebhookUrlError) {
          throw new ServiceValidationError(error.message);
        }
        throw error;
      }
    }

    const environmentTypes =
      options.environmentTypes.length === 0
        ? (["STAGING", "PRODUCTION"] satisfies RuntimeEnvironmentType[])
        : options.environmentTypes;

    const integrationId =
      options.channel.type === "SLACK" ? (options.channel.integrationId ?? null) : null;

    if (integrationId) {
      await assertSlackIntegrationInOrganization(
        this._prisma,
        integrationId,
        project.organizationId
      );
    }

    const { authorizedChannel } = options;
    const existingAlertChannel =
      authorizedChannel !== undefined
        ? authorizedChannel
        : options.deduplicationKey && !options.createOnly
          ? await this._prisma.projectAlertChannel.findFirst({
              where: {
                projectId: project.id,
                deduplicationKey: options.deduplicationKey,
              },
            })
          : undefined;

    if (existingAlertChannel) {
      const data = {
        name: options.name,
        alertTypes: options.alertTypes,
        type: options.channel.type,
        properties: await this.#createProperties(options.channel),
        integrationId,
        environmentTypes,
        enabled: true,
      };
      let updated: ProjectAlertChannel;
      if (authorizedChannel) {
        const { count } = await this._prisma.projectAlertChannel.updateMany({
          where: {
            id: authorizedChannel.id,
            projectId: project.id,
            deduplicationKey: options.deduplicationKey,
            environmentTypes: { equals: authorizedChannel.environmentTypes },
          },
          data,
        });
        if (count === 0) {
          throw new AlertChannelChangedError();
        }
        const reread = await this._prisma.projectAlertChannel.findFirst({
          where: { id: authorizedChannel.id },
        });
        if (!reread) {
          throw new AlertChannelChangedError();
        }
        updated = reread;
      } else {
        updated = await this._prisma.projectAlertChannel.update({
          where: { id: existingAlertChannel.id },
          data,
        });
      }

      if (options.alertTypes.includes("ERROR_GROUP")) {
        await this.#scheduleErrorAlertEvaluation(project.id);
      }

      return updated;
    }

    if (!options.deduplicationKey) {
      const identical = await this.#findIdentical(
        project.id,
        options,
        environmentTypes,
        integrationId
      );
      if (identical) {
        return identical;
      }
    }

    const alertChannel = await this._prisma.projectAlertChannel
      .create({
        data: {
          friendlyId: generateFriendlyId("alert_channel"),
          name: options.name,
          alertTypes: options.alertTypes,
          projectId: project.id,
          type: options.channel.type,
          properties: await this.#createProperties(options.channel),
          integrationId,
          enabled: true,
          deduplicationKey: options.deduplicationKey,
          userProvidedDeduplicationKey: Boolean(options.deduplicationKey),
          environmentTypes,
        },
      })
      .catch((error) => {
        if (
          authorizedChannel === null &&
          isUniqueConstraintError(error, ["projectId", "deduplicationKey"])
        ) {
          throw new AlertChannelChangedError();
        }
        throw error;
      });

    if (options.alertTypes.includes("ERROR_GROUP")) {
      await this.#scheduleErrorAlertEvaluation(project.id);
    }

    return alertChannel;
  }

  async #findIdentical(
    projectId: string,
    options: CreateAlertChannelOptions,
    environmentTypes: RuntimeEnvironmentType[],
    integrationId: string | null
  ): Promise<ProjectAlertChannel | undefined> {
    const { channel } = options;
    const candidates = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId,
        enabled: true,
        name: options.name,
        type: channel.type,
        alertTypes: { equals: options.alertTypes },
        environmentTypes: { equals: environmentTypes },
        integrationId,
        properties:
          channel.type === "EMAIL"
            ? { path: ["email"], equals: channel.email }
            : channel.type === "WEBHOOK"
              ? { path: ["url"], equals: channel.url }
              : { path: ["channelId"], equals: channel.channelId },
        AND:
          channel.type === "WEBHOOK" ? [{ properties: { path: ["version"], equals: "v2" } }] : [],
      },
      orderBy: { createdAt: "asc" },
    });

    if (channel.type !== "WEBHOOK" || channel.secret === undefined) {
      return candidates[0];
    }

    for (const candidate of candidates) {
      const secret = EncryptedSecretValueSchema.safeParse(
        (candidate.properties as Record<string, unknown> | null)?.secret
      );
      if (
        secret.success &&
        (await decryptSecret(env.ENCRYPTION_KEY, secret.data)) === channel.secret
      ) {
        return candidate;
      }
    }
  }

  async #scheduleErrorAlertEvaluation(projectId: string): Promise<void> {
    await alertsWorker.enqueue({
      id: `evaluateErrorAlerts:${projectId}`,
      job: "v3.evaluateErrorAlerts",
      payload: {
        projectId,
        scheduledAt: Date.now(),
      },
    });
  }

  async #createProperties(channel: CreateAlertChannelOptions["channel"]) {
    switch (channel.type) {
      case "EMAIL":
        return {
          email: channel.email,
        };
      case "WEBHOOK":
        return {
          url: channel.url,
          secret: await encryptSecret(env.ENCRYPTION_KEY, channel.secret ?? nanoid()),
          version: "v2",
        };
      case "SLACK":
        return {
          channelId: channel.channelId,
          channelName: channel.channelName,
          integrationId: channel.integrationId,
        };
    }
  }
}

export async function assertSlackIntegrationInOrganization(
  prisma: PrismaClientOrTransaction,
  integrationId: string,
  organizationId: string
) {
  const integration = await prisma.organizationIntegration.findFirst({
    where: { id: integrationId, service: "SLACK", organizationId, deletedAt: null },
    select: { id: true },
  });

  if (!integration) {
    throw new ServiceValidationError("Slack integration not found");
  }
}
