import { TaskRunError, createJsonErrorObject } from "@trigger.dev/core/v3";
import assertNever from "assert-never";
import { subtle } from "crypto";
import { Prisma, PrismaClientOrTransaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertSlackStorage,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { sendEmail } from "~/services/email.server";
import { logger } from "~/services/logger.server";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";

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
>;

export class DeliverAlertService extends BaseService {
  public async call(alertId: string) {
    const alert = await this._prisma.projectAlert.findUnique({
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

    if (alert.environment.type === "DEVELOPMENT") {
      return;
    }

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
          const taskRunError = TaskRunError.safeParse(alert.taskRunAttempt.error);

          if (!taskRunError.success) {
            logger.error("[DeliverAlert] Failed to parse task run error", {
              issues: taskRunError.error.issues,
              taskAttemptError: alert.taskRunAttempt.error,
            });

            return;
          }

          await sendEmail({
            email: "alert-attempt",
            to: emailProperties.data.email,
            taskIdentifier: alert.taskRunAttempt.taskRun.taskIdentifier,
            fileName: alert.taskRunAttempt.backgroundWorkerTask.filePath,
            exportName: alert.taskRunAttempt.backgroundWorkerTask.exportName,
            version: alert.taskRunAttempt.backgroundWorker.version,
            environment: alert.environment.slug,
            error: createJsonErrorObject(taskRunError.data),
            attemptLink: `${env.APP_ORIGIN}/projects/v3/${alert.project.externalRef}/runs/${alert.taskRunAttempt.taskRun.friendlyId}`,
          });
        } else {
          logger.error("[DeliverAlert] Task run attempt not found", {
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

          await sendEmail({
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
          await sendEmail({
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
            logger.error("[DeliverAlert] Failed to parse task run error", {
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

    // Get the client
    const client = await OrgIntegrationRepository.getAuthenticatedClientForIntegration(
      integration,
      { forceBotToken: true }
    );

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
            logger.error("[DeliverAlert] Failed to parse task run error", {
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

          try {
            const message = await client.chat.postMessage({
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
                    text: `\`\`\`${error.stackTrace ?? error.message}\`\`\``,
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
          } catch (error) {
            logger.error("[DeliverAlert] Failed to send slack message", {
              error,
              alert,
            });

            throw error;
          }
        } else {
          logger.error("[DeliverAlert] Task run attempt not found", {
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

          try {
            await client.chat.postMessage({
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
                    text: `\`\`\`${preparedError.stack ?? preparedError.message}\`\`\``,
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
          } catch (error) {
            logger.error("[DeliverAlert] Failed to send slack message", {
              error,
              alert,
            });

            throw error;
          }
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

          await client.chat.postMessage({
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
        queueName: options?.queueName,
      }
    );
  }
}
