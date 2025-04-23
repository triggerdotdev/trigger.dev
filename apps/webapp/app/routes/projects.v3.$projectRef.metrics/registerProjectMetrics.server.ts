import { TaskQueue } from "@trigger.dev/database";
import { Gauge, Registry } from "prom-client";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "~/v3/marqs/index.server";

export async function registerProjectMetrics(
  registry: Registry,
  projectId: string,
  userId: string
) {
  // Register project metrics here
  // Register queue metrics here

  // Find the dev runtime environment for this project/user
  const allEnvironments = await prisma.runtimeEnvironment.findMany({
    where: {
      projectId,
    },
    include: {
      taskQueues: true,
      project: true,
      organization: true,
      orgMember: true,
    },
  });

  for (const env of allEnvironments) {
    if (env.type === "DEVELOPMENT" && env.orgMember?.userId === userId) {
      await registerEnvironmentMetrics(env, registry);
    } else if (env.type !== "DEVELOPMENT") {
      await registerEnvironmentMetrics(env, registry);
    }
  }
}

async function registerEnvironmentMetrics(
  env: AuthenticatedEnvironment & { taskQueues: TaskQueue[] },
  registry: Registry
) {
  new Gauge({
    name: sanitizeMetricName(`trigger_env_queue_${env.slug}_concurrency`),
    help: `The number of tasks currently being executed in the dev environment queue`,
    registers: [registry],
    async collect() {
      const length = await marqs?.currentConcurrencyOfEnvironment(env);

      if (length) {
        this.set(length);
      }
    },
  });

  new Gauge({
    name: sanitizeMetricName(`trigger_env_queue_${env.slug}_concurrency_limit`),
    help: `The concurrency limit for the dev environment queue`,
    registers: [registry],
    async collect() {
      const length = await marqs?.getEnvConcurrencyLimit(env);

      if (length) {
        this.set(length);
      }
    },
  });

  new Gauge({
    name: sanitizeMetricName(`trigger_env_queue_${env.slug}_capacity`),
    help: `The capacity of the dev environment queue`,
    registers: [registry],
    async collect() {
      const concurrencyLimit = await marqs?.getEnvConcurrencyLimit(env);
      const currentConcurrency = await marqs?.currentConcurrencyOfEnvironment(env);

      if (typeof concurrencyLimit === "number" && typeof currentConcurrency === "number") {
        this.set(concurrencyLimit - currentConcurrency);
      }
    },
  });

  for (const queue of env.taskQueues) {
    registerTaskQueueMetrics(registry, queue, env);
  }
}

function registerTaskQueueMetrics(
  registry: Registry,
  queue: TaskQueue,
  env: AuthenticatedEnvironment
) {
  new Gauge({
    name: sanitizeMetricName(`trigger_${env.slug}_task_queue_${queue.name}_length`),
    help: `The number of tasks in the ${queue.name} queue`,
    registers: [registry],
    async collect() {
      const length = await marqs?.lengthOfQueue(env, queue.name);

      if (length) {
        this.set(length);
      }
    },
  });

  new Gauge({
    name: sanitizeMetricName(`trigger_${env.slug}_task_queue_${queue.name}_concurrency`),
    help: `The number of tasks currently being executed in the ${queue.name} queue`,
    registers: [registry],
    async collect() {
      const length = await marqs?.currentConcurrencyOfQueue(env, queue.name);

      if (length) {
        this.set(length);
      }
    },
  });

  new Gauge({
    name: sanitizeMetricName(`trigger_${env.slug}_task_queue_${queue.name}_concurrency_limit`),
    help: `The concurrency limit for the ${queue.name} queue`,
    registers: [registry],
    async collect() {
      const length = await marqs?.getQueueConcurrencyLimit(env, queue.name);

      if (length) {
        this.set(length);
      }
    },
  });

  new Gauge({
    name: sanitizeMetricName(`trigger_${env.slug}_task_queue_${queue.name}_capacity`),
    help: `The capacity of the ${queue.name} queue`,
    registers: [registry],
    async collect() {
      const concurrencyLimit = await marqs?.getQueueConcurrencyLimit(env, queue.name);
      const currentConcurrency = await marqs?.currentConcurrencyOfQueue(env, queue.name);

      if (typeof concurrencyLimit === "number" && typeof currentConcurrency === "number") {
        this.set(concurrencyLimit - currentConcurrency);
      }
    },
  });

  new Gauge({
    name: sanitizeMetricName(`trigger_${env.slug}_task_queue_${queue.name}_oldest_message_age`),
    help: `The age of the oldest message in the ${queue.name} queue`,
    registers: [registry],
    async collect() {
      const oldestMessage = await marqs?.oldestMessageInQueue(env, queue.name);

      if (oldestMessage) {
        this.set(oldestMessage);
      }
    },
  });
}

function sanitizeMetricName(name: string) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
