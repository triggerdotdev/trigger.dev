import { PrismaClientOrTransaction, prisma, Prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";
import assertNever from "assert-never";
import { sendEmail } from "~/services/email.server";
import { env } from "~/env.server";
import { TaskRunError, createJsonErrorObject } from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { createHmac } from "crypto";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";

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

  async #sendSlack(alert: FoundAlert) {
    // TODO: Implement
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

  async #deliverWebhook(payload: any, webhook: ProjectAlertWebhookProperties) {
    const rawBody = JSON.stringify(payload);

    // Sign the rawBody with the properties.secret using HMAC SHA256 and add a signature header to the request
    const hmac = createHmac("sha256", webhook.secret);
    hmac.update(rawBody);
    const signature = hmac.digest("hex");

    // Send the webhook to the URL specified in webhook.url
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trigger-signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(2000),
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

  static async enqueue(alertId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.deliverAlert",
      {
        alertId,
      },
      {
        tx,
        runAt,
        jobKey: `deliverAlert:${alertId}`,
      }
    );
  }
}
