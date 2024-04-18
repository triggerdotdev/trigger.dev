import { LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { TaskQueue } from "@trigger.dev/database";
import { Gauge, Registry } from "prom-client";
import { z } from "zod";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { marqs } from "~/v3/marqs/index.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const validatedParams = ParamsSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      externalRef: validatedParams.projectRef,
      organization: {
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  const registry = new Registry();
  // Return prometheus metrics for the project (queues)

  await registerProjectMetrics(registry, project.id, authenticationResult.userId);

  return new Response(await registry.metrics(), {
    headers: {
      "Content-Type": registry.contentType,
    },
  });
}

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

  const firstEnv = allEnvironments[0];

  if (firstEnv) {
    new Gauge({
      name: sanitizeMetricName(`trigger_org_queue_concurrency`),
      help: `The number of tasks currently being executed in the org environment queue`,
      registers: [registry],
      async collect() {
        const length = await marqs?.currentConcurrencyOfOrg(firstEnv);

        if (length) {
          this.set(length);
        }
      },
    });

    new Gauge({
      name: sanitizeMetricName(`trigger_org_queue_concurrency_limit`),
      help: `The concurrency limit for the org queue`,
      registers: [registry],
      async collect() {
        const length = await marqs?.getOrgConcurrencyLimit(firstEnv);

        if (length) {
          this.set(length);
        }
      },
    });

    new Gauge({
      name: sanitizeMetricName(`trigger_org_queue_capacity`),
      help: "The capacity of the org queue",
      registers: [registry],
      async collect() {
        const concurrencyLimit = await marqs?.getOrgConcurrencyLimit(firstEnv);
        const currentConcurrency = await marqs?.currentConcurrencyOfOrg(firstEnv);

        if (typeof concurrencyLimit === "number" && typeof currentConcurrency === "number") {
          this.set(concurrencyLimit - currentConcurrency);
        }
      },
    });
  }

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
