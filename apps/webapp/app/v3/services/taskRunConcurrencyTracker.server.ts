import { env } from "~/env.server";
import Redis, { type RedisOptions } from "ioredis";
import { singleton } from "~/utils/singleton";
import { type MessagePayload, type MessageQueueSubscriber } from "../marqs/types";
import { z } from "zod";
import { logger } from "~/services/logger.server";

type Options = {
  redis: RedisOptions;
};

const ConcurrentMessageData = z.object({
  taskIdentifier: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  environmentType: z.string(),
});

class TaskRunConcurrencyTracker implements MessageQueueSubscriber {
  private redis: Redis;

  constructor(config: Options) {
    this.redis = new Redis(config.redis);
  }

  async messageEnqueued(message: MessagePayload): Promise<void> {}

  async messageDequeued(message: MessagePayload): Promise<void> {
    logger.debug("TaskRunConcurrencyTracker.messageDequeued()", {
      data: message.data,
      messageId: message.messageId,
    });

    const data = this.getMessageData(message);
    if (!data) {
      logger.info(
        `TaskRunConcurrencyTracker.messageDequeued(): could not parse message data`,
        message
      );
      return;
    }

    await this.executionStarted({
      projectId: data.projectId,
      taskId: data.taskIdentifier,
      runId: message.messageId,
      environmentId: data.environmentId,
      deployed: data.environmentType !== "DEVELOPMENT",
    });
  }

  async messageAcked(message: MessagePayload): Promise<void> {
    logger.debug("TaskRunConcurrencyTracker.messageAcked()", {
      data: message.data,
      messageId: message.messageId,
    });

    const data = this.getMessageData(message);
    if (!data) {
      logger.info(
        `TaskRunConcurrencyTracker.messageAcked(): could not parse message data`,
        message
      );
      return;
    }

    await this.executionFinished({
      projectId: data.projectId,
      taskId: data.taskIdentifier,
      runId: message.messageId,
      environmentId: data.environmentId,
      deployed: data.environmentType !== "DEVELOPMENT",
    });
  }

  async messageNacked(message: MessagePayload): Promise<void> {
    logger.debug("TaskRunConcurrencyTracker.messageNacked()", {
      data: message.data,
      messageId: message.messageId,
    });

    const data = this.getMessageData(message);
    if (!data) {
      logger.info(
        `TaskRunConcurrencyTracker.messageNacked(): could not parse message data`,
        message
      );
      return;
    }

    await this.executionFinished({
      projectId: data.projectId,
      taskId: data.taskIdentifier,
      runId: message.messageId,
      environmentId: data.environmentId,
      deployed: data.environmentType !== "DEVELOPMENT",
    });
  }

  async messageReplaced(message: MessagePayload): Promise<void> {
    logger.debug("TaskRunConcurrencyTracker.messageReplaced()", {
      data: message.data,
      messageId: message.messageId,
    });

    const data = this.getMessageData(message);
    if (!data) {
      logger.info(
        `TaskRunConcurrencyTracker.messageReplaced(): could not parse message data`,
        message
      );
      return;
    }

    await this.executionFinished({
      projectId: data.projectId,
      taskId: data.taskIdentifier,
      runId: message.messageId,
      environmentId: data.environmentId,
      deployed: data.environmentType !== "DEVELOPMENT",
    });
  }

  async messageRequeued(message: MessagePayload): Promise<void> {
    logger.debug("TaskRunConcurrencyTracker.messageRequeued()", {
      data: message.data,
      messageId: message.messageId,
    });

    const data = this.getMessageData(message);

    if (!data) {
      logger.info(
        `TaskRunConcurrencyTracker.messageReplaced(): could not parse message data`,
        message
      );
      return;
    }

    await this.executionFinished({
      projectId: data.projectId,
      taskId: data.taskIdentifier,
      runId: message.messageId,
      environmentId: data.environmentId,
      deployed: data.environmentType !== "DEVELOPMENT",
    });
  }

  private getMessageData(message: MessagePayload) {
    const result = ConcurrentMessageData.safeParse(message.data);
    if (result.success) {
      return result.data;
    }
    return;
  }

  private async executionStarted({
    projectId,
    taskId,
    runId,
    environmentId,
    deployed,
  }: {
    projectId: string;
    taskId: string;
    runId: string;
    environmentId: string;
    deployed: boolean;
  }): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();

      pipeline.sadd(this.getTaskKey(projectId, taskId), runId);
      pipeline.sadd(this.getTaskEnvironmentKey(projectId, taskId, environmentId), runId);
      pipeline.sadd(this.getEnvironmentKey(projectId, environmentId), runId);
      pipeline.sadd(this.getGlobalKey(deployed), runId);

      await pipeline.exec();
    } catch (error) {
      logger.error("TaskRunConcurrencyTracker.executionStarted() error", { error });
    }
  }

  private async executionFinished({
    projectId,
    taskId,
    runId,
    environmentId,
    deployed,
  }: {
    projectId: string;
    taskId: string;
    runId: string;
    environmentId: string;
    deployed: boolean;
  }): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();

      pipeline.srem(this.getTaskKey(projectId, taskId), runId);
      pipeline.srem(this.getTaskEnvironmentKey(projectId, taskId, environmentId), runId);
      pipeline.srem(this.getEnvironmentKey(projectId, environmentId), runId);
      pipeline.srem(this.getGlobalKey(deployed), runId);

      await pipeline.exec();
    } catch (error) {
      logger.error("TaskRunConcurrencyTracker.executionFinished() error", { error });
    }
  }

  async taskConcurrentRunCount(projectId: string, taskId: string): Promise<number> {
    return await this.redis.scard(this.getTaskKey(projectId, taskId));
  }

  async globalConcurrentRunCount(deployed: boolean): Promise<number> {
    return await this.redis.scard(this.getGlobalKey(deployed));
  }

  async currentlyExecutingRuns(projectId: string, taskId: string): Promise<string[]> {
    return await this.redis.smembers(this.getTaskKey(projectId, taskId));
  }

  private async getTaskCounts(projectId: string, taskIds: string[]): Promise<number[]> {
    try {
      const pipeline = this.redis.pipeline();
      taskIds.forEach((taskId) => {
        pipeline.scard(this.getTaskKey(projectId, taskId));
      });
      const results = await pipeline.exec();
      if (!results) {
        return [];
      }
      return results.map(([err, count]) => {
        if (err) {
          console.error("Error in getTaskCounts:", err);
          return 0;
        }
        return count as number;
      });
    } catch (error) {
      logger.error("TaskRunConcurrencyTracker.getTaskCounts() error", { error });
      return [];
    }
  }

  async projectTotalConcurrentRunCount(projectId: string, taskIds: string[]): Promise<number> {
    const counts = await this.getTaskCounts(projectId, taskIds);
    return counts.reduce((total, count) => total + count, 0);
  }

  async taskConcurrentRunCounts(
    projectId: string,
    taskIds: string[]
  ): Promise<Record<string, number>> {
    const counts = await this.getTaskCounts(projectId, taskIds);
    return taskIds.reduce((acc, taskId, index) => {
      acc[taskId] = counts[index] ?? 0;
      return acc;
    }, {} as Record<string, number>);
  }

  async environmentConcurrentRunCounts(
    projectId: string,
    environmentIds: string[]
  ): Promise<Record<string, number>> {
    try {
      const pipeline = this.redis.pipeline();
      environmentIds.forEach((environmentId) => {
        pipeline.scard(this.getEnvironmentKey(projectId, environmentId));
      });
      const results = await pipeline.exec();
      if (!results) {
        return Object.fromEntries(environmentIds.map((id) => [id, 0]));
      }

      return results.reduce((acc, [err, count], index) => {
        if (err) {
          console.error("Error in environmentConcurrentRunCounts:", err);
          return acc;
        }
        acc[environmentIds[index]] = count as number;
        return acc;
      }, {} as Record<string, number>);
    } catch (error) {
      logger.error("TaskRunConcurrencyTracker.environmentConcurrentRunCounts() error", { error });
      return Object.fromEntries(environmentIds.map((id) => [id, 0]));
    }
  }

  private getTaskKey(projectId: string, taskId: string): string {
    return `project:${projectId}:task:${taskId}`;
  }

  private getTaskEnvironmentKey(projectId: string, taskId: string, environmentId: string): string {
    return `project:${projectId}:task:${taskId}:env:${environmentId}`;
  }

  private getGlobalKey(deployed: boolean): string {
    return `global:${deployed ? "deployed" : "dev"}`;
  }

  private getEnvironmentKey(projectId: string, environmentId: string): string {
    return `project:${projectId}:env:${environmentId}`;
  }
}

export const concurrencyTracker = singleton("concurrency-tracker", getTracker);

function getTracker() {
  if (!env.REDIS_HOST || !env.REDIS_PORT) {
    throw new Error(
      "Could not initialize TaskRunConcurrencyTracker because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. "
    );
  }

  logger.debug("Initializing TaskRunConcurrencyTracker", {
    redisHost: env.REDIS_HOST,
    redisPort: env.REDIS_PORT,
  });

  return new TaskRunConcurrencyTracker({
    redis: {
      keyPrefix: "concurrencytracker:",
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
  });
}
