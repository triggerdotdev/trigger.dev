import { env } from "~/env.server";
import Redis, { type RedisOptions } from "ioredis";
import { singleton } from "~/utils/singleton";

type Options = {
  redis: RedisOptions;
};

class TaskRunConcurrencyTracker {
  private redis: Redis;

  constructor(config: Options) {
    this.redis = new Redis(config.redis);
  }

  private getTaskKey(projectId: string, taskId: string): string {
    return `project:${projectId}:task:${taskId}`;
  }
  private getGlobalKey(deployed: boolean): string {
    return `global:${deployed ? "deployed" : "dev"}`;
  }

  async runStarted({
    projectId,
    taskId,
    runId,
    deployed,
  }: {
    projectId: string;
    taskId: string;
    runId: string;
    deployed: boolean;
  }): Promise<void> {
    await this.redis.sadd(this.getTaskKey(projectId, taskId), runId);
    await this.redis.sadd(this.getGlobalKey(deployed), runId);
  }

  async runFinished({
    projectId,
    taskId,
    runId,
    deployed,
  }: {
    projectId: string;
    taskId: string;
    runId: string;
    deployed: boolean;
  }): Promise<void> {
    await this.redis.srem(this.getTaskKey(projectId, taskId), runId);
    await this.redis.srem(this.getGlobalKey(deployed), runId);
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
    const pipeline = this.redis.pipeline();
    taskIds.forEach((taskId) => {
      pipeline.scard(this.getTaskKey(projectId, taskId));
    });
    const results = await pipeline.exec();
    return results!.map(([err, count]) => {
      if (err) {
        console.error("Error in getTaskCounts:", err);
        return 0;
      }
      return count as number;
    });
  }

  async projectConcurrentRunCount(projectId: string, taskIds: string[]): Promise<number> {
    const counts = await this.getTaskCounts(projectId, taskIds);
    return counts.reduce((total, count) => total + count, 0);
  }

  async taskConcurrentRunCounts(
    projectId: string,
    taskIds: string[]
  ): Promise<Record<string, number>> {
    const counts = await this.getTaskCounts(projectId, taskIds);
    return taskIds.reduce((acc, taskId, index) => {
      acc[taskId] = counts[index];
      return acc;
    }, {} as Record<string, number>);
  }
}

export const concurrencyTracker = singleton("concurrency-tracker", getTracker);

function getTracker() {
  if (!env.REDIS_HOST || !env.REDIS_PORT) {
    throw new Error(
      "Could not initialize auto-increment counter because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. "
    );
  }

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
