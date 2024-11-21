import { RunEngine } from "@internal/run-engine";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { tracer } from "./tracer.server";
import { singleton } from "~/utils/singleton";
import { eventRepository } from "./eventRepository.server";
import { createJsonErrorObject } from "@trigger.dev/core/v3";

export const engine = singleton("RunEngine", createRunEngine);

export type { RunEngine };

function createRunEngine() {
  const engine = new RunEngine({
    prisma,
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    worker: {
      workers: 1,
      tasksPerWorker: env.WORKER_CONCURRENCY,
      pollIntervalMs: env.WORKER_POLL_INTERVAL,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer,
  });

  engine.eventBus.on("runSucceeded", async ({ time, run }) => {
    await eventRepository.completeEvent(run.spanId, {
      endTime: time,
      attributes: {
        isError: false,
        output: run.output,
        outputType: run.outputType,
      },
    });
  });

  engine.eventBus.on("runCancelled", async ({ time, run }) => {
    const inProgressEvents = await eventRepository.queryIncompleteEvents({
      runId: run.friendlyId,
    });

    await Promise.all(
      inProgressEvents.map((event) => {
        const error = createJsonErrorObject(run.error);
        return eventRepository.cancelEvent(event, time, error.message);
      })
    );
  });

  return engine;
}
