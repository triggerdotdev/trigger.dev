import {
  ChatPostMessageArguments,
  ErrorCode,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { TaskRunError, createJsonErrorObject } from "@trigger.dev/core/v3";
import assertNever from "assert-never";
import { subtle } from "crypto";
import { Prisma, PrismaClientOrTransaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  OrgIntegrationRepository,
  OrganizationIntegrationForService,
} from "~/models/orgIntegration.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertSlackStorage,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { sendAlertEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";
import { FINAL_ATTEMPT_STATUSES } from "~/v3/taskStatus";

type FoundAlert = Prisma.Result<
  typeof prisma.projectAlert,
  {
    include: {
      channel: true;
      project: {
        include: {
          organization: true;
        };
      };
      environment: true;
      taskRunAttempt: {
        include: {
          taskRun: true;
          backgroundWorkerTask: true;
          backgroundWorker: true;
        };
      };
      taskRun: {
        include: {
          lockedBy: true;
          lockedToVersion: true;
        };
      };
      workerDeployment: {
        include: {
          worker: {
            include: {
              tasks: true;
            };
          };
        };
      };
    };
  },
  "findUniqueOrThrow"
> & {
  failedAttempt?: Prisma.Result<
    typeof prisma.taskRunAttempt,
    { select: { output: true; outputType: true; error: true } },
    "findFirst"
  >;
};

class SkipRetryError extends Error {}

export class DeliverAlertService extends BaseService {
  public async call(alertId: string) {
    const alert: FoundAlert | null = await this._prisma.projectAlert.findFirst({
      where: { id: alertId },
      include: {
        channel: true,
        project: {
          include: {
            organization: true,
          },
        },
        environment: true,
        taskRunAttempt: {
          include: {
            taskRun: true,
            backgroundWorkerTask: true,
            backgroundWorker: true,
          },
        },
        taskRun: {
          include: {
            lockedBy: true,
            lockedToVersion: true,
          },
        },
        workerDeployment: {
          include: {
            worker: {
              include: {
                tasks: true,
              },
            },
          },
        },
      },
    });

    if (!alert) {
      return;
    }

    if (alert.status !== "PENDING") {
      return;
    }

    if (alert.taskRun) {
      const finishedAttempt = await this._prisma.taskRunAttempt.findFirst({
        select: {
          output: true,
          outputType: true,
          error: true,
        },
        where: {
          status: { in: FINAL_ATTEMPT_STATUSES },
          taskRunId: alert.taskRun.id,
        },
        orderBy: {
          createdAt: "desc",
        },
      });
      alert.failedAttempt = finishedAttempt;
    }

    try {
      switch (alert.channel.type) {
        case "EMAIL": {
          await this.#sendEmail(alert);
          break;
        }
        case "SLACK": {
          await this.#sendSlack(alert);
          break;
        }
        case "WEBHOOK": {
          await this.#sendWebhook(alert);
          break;
        }
        default: {
          assertNever(alert.channel.type);
        }
      }
    } catch (error) {
      if (error instanceof SkipRetryError) {
        logger.error("[DeliverAlert] Skipping retry", {
          reason: error.message,
        });

        return;
      }

      throw error;
    }

    await this._prisma.projectAlert.update({
      where: { id: alertId },
      data: {
        status: "SENT",
      },
    });
  }

  async #sendEmail(alert: FoundAlert) {
    const emailProperties = ProjectAlertEmailProperties.safeParse(alert.channel.properties);

    if (!emailProperties.success) {
      logger.error("[DeliverAlert] Failed to parse email properties", {
        issues: emailProperties.error.issues,
        properties: alert.channel.properties,
      });

      return;
    }

    switch (alert.type) {
      case "TASK_RUN_ATTEMPT": {
        if (alert.taskRunAttempt) {
          const parseError = TaskRunError.safeParse(alert.taskRunAttempt.error);

          let taskRunError: TaskRunError;

          if (!parseError.success) {
            logger.error("[DeliverAlert] Attempt: Failed to parse task run error", {
              issues: parseError.error.issues,
              taskAttemptError: alert.taskRunAttempt.error,
            });

            taskRunError = {
              type: "STRING_ERROR" as const,
              raw: "No error on task",
            };
          } else {
            taskRunError = parseError.data;
          }

          await sendAlertEmail({
            email: "alert-attempt",
            to: emailProperties.data.email,
            taskIdentifier: alert.taskRunAttempt.taskRun.taskIdentifier,
            fileName: alert.taskRunAttempt.backgroundWorkerTask.filePath,
            exportName: alert.taskRunAttempt.backgroundWorkerTask.exportName,
            version: alert.taskRunAttempt.backgroundWorker.version,
            environment: alert.environment.slug,
            error: createJsonErrorObject(taskRunError),
            attemptLink: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/runs/${alert.taskRunAttempt.taskRun.friendlyId}`,
          });
        } else {
          logger.error("[DeliverAlert] Task run attempt not found", {
            alert,
          });
        }

        break;
      }
      case "TASK_RUN": {
        if (alert.taskRun) {
          const taskRunError = this.#getRunError(alert);

          await sendAlertEmail({
            email: "alert-run",
            to: emailProperties.data.email,
            runId: alert.taskRun.friendlyId,
            taskIdentifier: alert.taskRun.taskIdentifier,
            fileName: alert.taskRun.lockedBy?.filePath ?? "Unknown",
            exportName: alert.taskRun.lockedBy?.exportName ?? "Unknown",
            version: alert.taskRun.lockedToVersion?.version ?? "Unknown",
            project: alert.project.name,
            environment: alert.environment.slug,
            error: createJsonErrorObject(taskRunError),
            runLink: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/runs/${alert.taskRun.friendlyId}`,
          });
        } else {
          logger.error("[DeliverAlert] Task run not found", {
            alert,
          });
        }

        break;
      }
      case "DEPLOYMENT_FAILURE": {
        if (alert.workerDeployment) {
          const preparedError = DeploymentPresenter.prepareErrorData(
            alert.workerDeployment.errorData
          );

          if (!preparedError) {
            logger.error("[DeliverAlert] Failed to prepare deployment error data", {
              errorData: alert.workerDeployment.errorData,
            });

            return;
          }

          await sendAlertEmail({
            email: "alert-deployment-failure",
            to: emailProperties.data.email,
            version: alert.workerDeployment.version,
            environment: alert.environment.slug,
            shortCode: alert.workerDeployment.shortCode,
            failedAt: alert.workerDeployment.failedAt ?? new Date(),
            error: preparedError,
            deploymentLink: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/deployments/${alert.workerDeployment.shortCode}`,
          });
        } else {
          logger.error("[DeliverAlert] Worker deployment not found", {
            alert,
          });
        }

        break;
      }
      case "DEPLOYMENT_SUCCESS": {
        if (alert.workerDeployment) {
          await sendAlertEmail({
            email: "alert-deployment-success",
            to: emailProperties.data.email,
            version: alert.workerDeployment.version,
            environment: alert.environment.slug,
            shortCode: alert.workerDeployment.shortCode,
            deployedAt: alert.workerDeployment.deployedAt ?? new Date(),
            deploymentLink: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/deployments/${alert.workerDeployment.shortCode}`,
            taskCount: alert.workerDeployment.worker?.tasks.length ?? 0,
          });
        } else {
          logger.error("[DeliverAlert] Worker deployment not found", {
            alert,
          });
        }

        break;
      }
      default: {
        assertNever(alert.type);
      }
    }
  }

  async #sendWebhook(alert: FoundAlert) {
    const webhookProperties = ProjectAlertWebhookProperties.safeParse(alert.channel.properties);

    if (!webhookProperties.success) {
      logger.error("[DeliverAlert] Failed to parse webhook properties", {
        issues: webhookProperties.error.issues,
        properties: alert.channel.properties,
      });

      return;
    }

    switch (alert.type) {
      case "TASK_RUN_ATTEMPT": {
        if (alert.taskRunAttempt) {
          const taskRunError = TaskRunError.safeParse(alert.taskRunAttempt.error);

          if (!taskRunError.success) {
            logger.error("[DeliverAlert] Attempt: Failed to parse task run error", {
              issues: taskRunError.error.issues,
              taskAttemptError: alert.taskRunAttempt.error,
            });

            return;
          }

          const error = createJsonErrorObject(taskRunError.data);

          const payload = {
            task: {
              id: alert.taskRunAttempt.taskRun.taskIdentifier,
              filePath: alert.taskRunAttempt.backgroundWorkerTask.filePath,
              exportName: alert.taskRunAttempt.backgroundWorkerTask.exportName,
            },
            attempt: {
              id: alert.taskRunAttempt.friendlyId,
              number: alert.taskRunAttempt.number,
              startedAt: alert.taskRunAttempt.startedAt,
              status: alert.taskRunAttempt.status,
            },
            run: {
              id: alert.taskRunAttempt.taskRun.friendlyId,
              isTest: alert.taskRunAttempt.taskRun.isTest,
              createdAt: alert.taskRunAttempt.taskRun.createdAt,
              idempotencyKey: alert.taskRunAttempt.taskRun.idempotencyKey,
            },
            environment: {
              id: alert.environment.id,
              type: alert.environment.type,
              slug: alert.environment.slug,
            },
            organization: {
              id: alert.project.organizationId,
              slug: alert.project.organization.slug,
              name: alert.project.organization.title,
            },
            project: {
              id: alert.project.id,
              ref: alert.project.externalRef,
              slug: alert.project.slug,
              name: alert.project.name,
            },
            error,
          };

          await this.#deliverWebhook(payload, webhookProperties.data);
        } else {
          logger.error("[DeliverAlert] Task run attempt not found", {
            alert,
          });
        }

        break;
      }
      case "TASK_RUN": {
        if (alert.taskRun) {
          const error = this.#getRunError(alert);

          const payload = {
            task: {
              id: alert.taskRun.taskIdentifier,
              fileName: alert.taskRun.lockedBy?.filePath ?? "Unknown",
              exportName: alert.taskRun.lockedBy?.exportName ?? "Unknown",
            },
            run: {
              id: alert.taskRun.friendlyId,
              isTest: alert.taskRun.isTest,
              createdAt: alert.taskRun.createdAt,
              idempotencyKey: alert.taskRun.idempotencyKey,
            },
            environment: {
              id: alert.environment.id,
              type: alert.environment.type,
              slug: alert.environment.slug,
            },
            organization: {
              id: alert.project.organizationId,
              slug: alert.project.organization.slug,
              name: alert.project.organization.title,
            },
            project: {
              id: alert.project.id,
              ref: alert.project.externalRef,
              slug: alert.project.slug,
              name: alert.project.name,
            },
            error,
          };

          await this.#deliverWebhook(payload, webhookProperties.data);
        } else {
          logger.error("[DeliverAlert] Task run not found", {
            alert,
          });
        }

        break;
      }
      case "DEPLOYMENT_FAILURE": {
        if (alert.workerDeployment) {
          const preparedError = DeploymentPresenter.prepareErrorData(
            alert.workerDeployment.errorData
          );

          if (!preparedError) {
            logger.error("[DeliverAlert] Failed to prepare deployment error data", {
              errorData: alert.workerDeployment.errorData,
            });

            return;
          }

          const payload = {
            deployment: {
              id: alert.workerDeployment.friendlyId,
              status: alert.workerDeployment.status,
              version: alert.workerDeployment.version,
              shortCode: alert.workerDeployment.shortCode,
              failedAt: alert.workerDeployment.failedAt ?? new Date(),
            },
            environment: {
              id: alert.environment.id,
              type: alert.environment.type,
              slug: alert.environment.slug,
            },
            organization: {
              id: alert.project.organizationId,
              slug: alert.project.organization.slug,
              name: alert.project.organization.title,
            },
            project: {
              id: alert.project.id,
              ref: alert.project.externalRef,
              slug: alert.project.slug,
              name: alert.project.name,
            },
            error: preparedError,
          };

          await this.#deliverWebhook(payload, webhookProperties.data);
        } else {
          logger.error("[DeliverAlert] Worker deployment not found", {
            alert,
          });
        }

        break;
      }
      case "DEPLOYMENT_SUCCESS": {
        if (alert.workerDeployment) {
          const payload = {
            deployment: {
              id: alert.workerDeployment.friendlyId,
              status: alert.workerDeployment.status,
              version: alert.workerDeployment.version,
              shortCode: alert.workerDeployment.shortCode,
              deployedAt: alert.workerDeployment.deployedAt ?? new Date(),
            },
            tasks:
              alert.workerDeployment.worker?.tasks.map((task) => ({
                id: task.slug,
                filePath: task.filePath,
                exportName: task.exportName,
                triggerSource: task.triggerSource,
              })) ?? [],
            environment: {
              id: alert.environment.id,
              type: alert.environment.type,
              slug: alert.environment.slug,
            },
            organization: {
              id: alert.project.organizationId,
              slug: alert.project.organization.slug,
              name: alert.project.organization.title,
            },
            project: {
              id: alert.project.id,
              ref: alert.project.externalRef,
              slug: alert.project.slug,
              name: alert.project.name,
            },
          };

          await this.#deliverWebhook(payload, webhookProperties.data);
        } else {
          logger.error("[DeliverAlert] Worker deployment not found", {
            alert,
          });
        }

        break;
      }
      default: {
        assertNever(alert.type);
      }
    }
  }

  async #sendSlack(alert: FoundAlert) {
    const slackProperties = ProjectAlertSlackProperties.safeParse(alert.channel.properties);

    if (!slackProperties.success) {
      logger.error("[DeliverAlert] Failed to parse slack properties", {
        issues: slackProperties.error.issues,
        properties: alert.channel.properties,
      });

      return;
    }

    // Get the org integration
    const integration = slackProperties.data.integrationId
      ? await this._prisma.organizationIntegration.findUnique({
          where: {
            id: slackProperties.data.integrationId,
            organizationId: alert.project.organizationId,
          },
          include: {
            tokenReference: true,
          },
        })
      : await this._prisma.organizationIntegration.findFirst({
          where: {
            service: "SLACK",
            organizationId: alert.project.organizationId,
          },
          orderBy: {
            createdAt: "desc",
          },
          include: {
            tokenReference: true,
          },
        });

    if (!integration) {
      logger.error("[DeliverAlert] Slack integration not found", {
        alert,
      });

      return;
    }

    switch (alert.type) {
      case "TASK_RUN_ATTEMPT": {
        if (alert.taskRunAttempt) {
          // Find existing storage by the run ID
          const storage = await this._prisma.projectAlertStorage.findFirst({
            where: {
              alertChannelId: alert.channel.id,
              alertType: alert.type,
              storageId: alert.taskRunAttempt.taskRunId,
            },
          });

          const storageData = storage
            ? ProjectAlertSlackStorage.safeParse(storage.storageData)
            : undefined;

          const thread_ts =
            storageData && storageData.success ? storageData.data.message_ts : undefined;

          const taskRunError = TaskRunError.safeParse(alert.taskRunAttempt.error);

          if (!taskRunError.success) {
            logger.error("[DeliverAlert] Attempt: Failed to parse task run error", {
              issues: taskRunError.error.issues,
              taskAttemptError: alert.taskRunAttempt.error,
            });

            return;
          }

          const error = createJsonErrorObject(taskRunError.data);

          const exportName = alert.taskRunAttempt.backgroundWorkerTask.exportName;
          const version = alert.taskRunAttempt.backgroundWorker.version;
          const environment = alert.environment.slug;
          const taskIdentifier = alert.taskRunAttempt.backgroundWorkerTask.slug;
          const timestamp = alert.taskRunAttempt.completedAt ?? new Date();
          const runId = alert.taskRunAttempt.taskRun.friendlyId;
          const attemptNumber = alert.taskRunAttempt.number;

          const message = await this.#postSlackMessage(integration, {
            thread_ts,
            channel: slackProperties.data.channelId,
            text: `Task error in ${alert.taskRunAttempt.backgroundWorkerTask.exportName} [${alert.taskRunAttempt.backgroundWorker.version}.${alert.environment.slug}]`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `:rotating_light: Error in *${exportName}* _<!date^${Math.round(
                    timestamp.getTime() / 1000
                  )}^at {date_num} {time_secs}|${timestamp.toLocaleString()}>_`,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: this.#wrapInCodeBlock(error.stackTrace ?? error.message),
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `${runId}.${attemptNumber} | ${taskIdentifier} | ${version}.${environment} | ${alert.project.name}`,
                  },
                ],
              },
              {
                type: "divider",
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "Investigate",
                    },
                    url: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/runs/${alert.taskRunAttempt.taskRun.friendlyId}`,
                  },
                ],
              },
            ],
          });

          // Upsert the storage
          if (message.ts) {
            if (storage) {
              await this._prisma.projectAlertStorage.update({
                where: {
                  id: storage.id,
                },
                data: {
                  storageData: {
                    message_ts: message.ts,
                  },
                },
              });
            } else {
              await this._prisma.projectAlertStorage.create({
                data: {
                  alertChannelId: alert.channel.id,
                  alertType: alert.type,
                  storageId: alert.taskRunAttempt.taskRunId,
                  storageData: {
                    message_ts: message.ts,
                  },
                  projectId: alert.project.id,
                },
              });
            }
          }
        } else {
          logger.error("[DeliverAlert] Task run attempt not found", {
            alert,
          });
        }

        break;
      }
      case "TASK_RUN": {
        if (alert.taskRun) {
          // Find existing storage by the run ID
          const storage = await this._prisma.projectAlertStorage.findFirst({
            where: {
              alertChannelId: alert.channel.id,
              alertType: alert.type,
              storageId: alert.taskRun.id,
            },
          });

          const storageData = storage
            ? ProjectAlertSlackStorage.safeParse(storage.storageData)
            : undefined;

          const thread_ts =
            storageData && storageData.success ? storageData.data.message_ts : undefined;

          const taskRunError = this.#getRunError(alert);
          const error = createJsonErrorObject(taskRunError);

          const exportName = alert.taskRun.lockedBy?.exportName ?? "Unknown";
          const version = alert.taskRun.lockedToVersion?.version ?? "Unknown";
          const environment = alert.environment.slug;
          const taskIdentifier = alert.taskRun.taskIdentifier;
          const timestamp = alert.taskRun.completedAt ?? new Date();
          const runId = alert.taskRun.friendlyId;

          const message = await this.#postSlackMessage(integration, {
            thread_ts,
            channel: slackProperties.data.channelId,
            text: `Run ${runId} failed for ${taskIdentifier} [${version}.${environment}]`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `:rotating_light: Error in *${exportName}* _<!date^${Math.round(
                    timestamp.getTime() / 1000
                  )}^at {date_num} {time_secs}|${timestamp.toLocaleString()}>_`,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: this.#wrapInCodeBlock(error.stackTrace ?? error.message),
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `${runId} | ${taskIdentifier} | ${version}.${environment} | ${alert.project.name}`,
                  },
                ],
              },
              {
                type: "divider",
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "Investigate",
                    },
                    url: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/runs/${alert.taskRun.friendlyId}`,
                  },
                ],
              },
            ],
          });

          // Upsert the storage
          if (message.ts) {
            if (storage) {
              await this._prisma.projectAlertStorage.update({
                where: {
                  id: storage.id,
                },
                data: {
                  storageData: {
                    message_ts: message.ts,
                  },
                },
              });
            } else {
              await this._prisma.projectAlertStorage.create({
                data: {
                  alertChannelId: alert.channel.id,
                  alertType: alert.type,
                  storageId: alert.taskRun.id,
                  storageData: {
                    message_ts: message.ts,
                  },
                  projectId: alert.project.id,
                },
              });
            }
          }
        } else {
          logger.error("[DeliverAlert] Task run not found", {
            alert,
          });
        }

        break;
      }
      case "DEPLOYMENT_FAILURE": {
        if (alert.workerDeployment) {
          const preparedError = DeploymentPresenter.prepareErrorData(
            alert.workerDeployment.errorData
          );

          if (!preparedError) {
            logger.error("[DeliverAlert] Failed to prepare deployment error data", {
              errorData: alert.workerDeployment.errorData,
            });

            return;
          }

          const version = alert.workerDeployment.version;
          const environment = alert.environment.slug;
          const timestamp = alert.workerDeployment.failedAt ?? new Date();

          await this.#postSlackMessage(integration, {
            channel: slackProperties.data.channelId,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `:rotating_light: Deployment failed *${version}.${environment}* _<!date^${Math.round(
                    timestamp.getTime() / 1000
                  )}^at {date_num} {time_secs}|${timestamp.toLocaleString()}>_`,
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: this.#wrapInCodeBlock(preparedError.stack ?? preparedError.message),
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `${alert.workerDeployment.shortCode} | ${version}.${environment} | ${alert.project.name}`,
                  },
                ],
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "View Deployment",
                    },
                    url: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/deployments/${alert.workerDeployment.shortCode}`,
                  },
                ],
              },
            ],
          });
        } else {
          logger.error("[DeliverAlert] Worker deployment not found", {
            alert,
          });
        }

        break;
      }
      case "DEPLOYMENT_SUCCESS": {
        if (alert.workerDeployment) {
          const version = alert.workerDeployment.version;
          const environment = alert.environment.slug;
          const numberOfTasks = alert.workerDeployment.worker?.tasks.length ?? 0;
          const timestamp = alert.workerDeployment.deployedAt ?? new Date();

          await this.#postSlackMessage(integration, {
            channel: slackProperties.data.channelId,
            text: `Deployment ${alert.workerDeployment.version} [${alert.environment.slug}] succeeded`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `:rocket: Deployed *${version}.${environment}* successfully _<!date^${Math.round(
                    timestamp.getTime() / 1000
                  )}^at {date_num} {time_secs}|${timestamp.toLocaleString()}>_`,
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `${numberOfTasks} tasks | ${alert.workerDeployment.shortCode} | ${version}.${environment} | ${alert.project.name}`,
                  },
                ],
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "View Deployment",
                    },
                    url: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/deployments/${alert.workerDeployment.shortCode}`,
                  },
                ],
              },
            ],
          });

          return;
        } else {
          logger.error("[DeliverAlert] Worker deployment not found", {
            alert,
          });

          return;
        }
      }
      default: {
        assertNever(alert.type);
      }
    }
  }

  async #deliverWebhook(payload: any, webhook: ProjectAlertWebhookProperties) {
    const rawPayload = JSON.stringify(payload);
    const hashPayload = Buffer.from(rawPayload, "utf-8");

    const secret = await decryptSecret(env.ENCRYPTION_KEY, webhook.secret);

    const hmacSecret = Buffer.from(secret, "utf-8");
    const key = await subtle.importKey(
      "raw",
      hmacSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await subtle.sign("HMAC", key, hashPayload);
    const signatureHex = Buffer.from(signature).toString("hex");

    // Send the webhook to the URL specified in webhook.url
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trigger-signature-hmacsha256": signatureHex,
      },
      body: rawPayload,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.error("[DeliverAlert] Failed to send alert webhook", {
        status: response.status,
        statusText: response.statusText,
        url: webhook.url,
        body: payload,
        signature,
      });

      throw new Error(`Failed to send alert webhook to ${webhook.url}`);
    }
  }

  async #postSlackMessage(
    integration: OrganizationIntegrationForService<"SLACK">,
    message: ChatPostMessageArguments
  ) {
    const client = await OrgIntegrationRepository.getAuthenticatedClientForIntegration(
      integration,
      { forceBotToken: true }
    );

    try {
      return await client.chat.postMessage(message);
    } catch (error) {
      if (isWebAPIRateLimitedError(error)) {
        logger.error("[DeliverAlert] Slack rate limited", {
          error,
          message,
        });

        throw new Error("Slack rate limited");
      }

      if (isWebAPIHTTPError(error)) {
        logger.error("[DeliverAlert] Slack HTTP error", {
          error,
          message,
        });

        throw new Error("Slack HTTP error");
      }

      if (isWebAPIRequestError(error)) {
        logger.error("[DeliverAlert] Slack request error", {
          error,
          message,
        });

        throw new Error("Slack request error");
      }

      if (isWebAPIPlatformError(error)) {
        logger.error("[DeliverAlert] Slack platform error", {
          error,
          message,
        });

        if (error.data.error === "invalid_blocks") {
          logger.error("[DeliverAlert] Slack invalid blocks", {
            error,
          });

          throw new SkipRetryError("Slack invalid blocks");
        }

        throw new Error("Slack platform error");
      }

      logger.error("[DeliverAlert] Failed to send slack message", {
        error,
        message,
      });

      throw error;
    }
  }

  #getRunError(alert: FoundAlert): TaskRunError {
    if (alert.failedAttempt) {
      const res = TaskRunError.safeParse(alert.failedAttempt.error);

      if (!res.success) {
        logger.error("[DeliverAlert] Failed to parse task run error, sending with unknown error", {
          issues: res.error.issues,
          taskAttemptError: alert.failedAttempt.error,
        });

        return {
          type: "CUSTOM_ERROR",
          raw: JSON.stringify(alert.failedAttempt.error ?? "Unknown error"),
        };
      }

      return res.data;
    }

    return {
      type: "CUSTOM_ERROR",
      raw: "No error on attempt",
    };
  }

  #wrapInCodeBlock(text: string, maxLength = 3000) {
    return `\`\`\`${this.#truncateSlackText(text, maxLength - 10)}\`\`\``;
  }

  #truncateSlackText(text: string, length = 3000) {
    if (text.length > length) {
      logger.debug("[DeliverAlert] Truncating slack text", {
        length,
        originalLength: text.length,
      });

      const truncationSuffix = "\n\ntruncated - check dashboard for complete error message";

      return text.slice(0, length - truncationSuffix.length) + truncationSuffix;
    }

    return text;
  }

  static async enqueue(
    alertId: string,
    tx: PrismaClientOrTransaction,
    options?: { runAt?: Date; queueName?: string }
  ) {
    return await workerQueue.enqueue(
      "v3.deliverAlert",
      {
        alertId,
      },
      {
        tx,
        runAt: options?.runAt,
        jobKey: `deliverAlert:${alertId}`,
      }
    );
  }
}

function isWebAPIPlatformError(error: unknown): error is WebAPIPlatformError {
  return (error as WebAPIPlatformError).code === ErrorCode.PlatformError;
}

function isWebAPIRequestError(error: unknown): error is WebAPIRequestError {
  return (error as WebAPIRequestError).code === ErrorCode.RequestError;
}

function isWebAPIHTTPError(error: unknown): error is WebAPIHTTPError {
  return (error as WebAPIHTTPError).code === ErrorCode.HTTPError;
}

function isWebAPIRateLimitedError(error: unknown): error is WebAPIRateLimitedError {
  return (error as WebAPIRateLimitedError).code === ErrorCode.RateLimitedError;
}
