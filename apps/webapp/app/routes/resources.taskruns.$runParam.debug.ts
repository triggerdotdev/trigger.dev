import { type LoaderFunctionArgs } from "@remix-run/node";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";

const ParamSchema = z.object({
  runParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { runParam } = ParamSchema.parse(params);

  const run = await $replica.taskRun.findFirst({
    where: { friendlyId: runParam, project: { organization: { members: { some: { userId } } } } },
    select: {
      id: true,
      engine: true,
      friendlyId: true,
      queue: true,
      concurrencyKey: true,
      queueTimestamp: true,
      runtimeEnvironment: {
        select: {
          id: true,
          type: true,
          slug: true,
          organizationId: true,
          project: true,
          maximumConcurrencyLimit: true,
          concurrencyLimitBurstFactor: true,
          organization: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  if (run.engine === "V1") {
    const queueConcurrencyLimit = await marqs.getQueueConcurrencyLimit(
      run.runtimeEnvironment,
      run.queue
    );
    const envConcurrencyLimit = await marqs.getEnvConcurrencyLimit(run.runtimeEnvironment);
    const queueCurrentConcurrency = await marqs.currentConcurrencyOfQueue(
      run.runtimeEnvironment,
      run.queue,
      run.concurrencyKey ?? undefined
    );
    const envCurrentConcurrency = await marqs.currentConcurrencyOfEnvironment(
      run.runtimeEnvironment
    );

    const queueReserveConcurrency = await marqs.reserveConcurrencyOfQueue(
      run.runtimeEnvironment,
      run.queue,
      run.concurrencyKey ?? undefined
    );

    const envReserveConcurrency = await marqs.reserveConcurrencyOfEnvironment(
      run.runtimeEnvironment
    );

    return typedjson({
      engine: "V1",
      run,
      queueConcurrencyLimit,
      envConcurrencyLimit,
      queueCurrentConcurrency,
      envCurrentConcurrency,
      queueReserveConcurrency,
      envReserveConcurrency,
      keys: [],
    });
  } else {
    const queueConcurrencyLimit = await engine.runQueue.getQueueConcurrencyLimit(
      run.runtimeEnvironment,
      run.queue
    );

    const envConcurrencyLimit = await engine.runQueue.getEnvConcurrencyLimit(
      run.runtimeEnvironment
    );

    const queueCurrentConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
      run.runtimeEnvironment,
      run.queue,
      run.concurrencyKey ?? undefined
    );

    const envCurrentConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
      run.runtimeEnvironment
    );

    const queueCurrentConcurrencyKey = engine.runQueue.keys.queueCurrentConcurrencyKey(
      run.runtimeEnvironment,
      run.queue,
      run.concurrencyKey ?? undefined
    );

    const envCurrentConcurrencyKey = engine.runQueue.keys.envCurrentConcurrencyKey(
      run.runtimeEnvironment
    );

    const queueConcurrencyLimitKey = engine.runQueue.keys.queueConcurrencyLimitKey(
      run.runtimeEnvironment,
      run.queue
    );

    const envConcurrencyLimitKey = engine.runQueue.keys.envConcurrencyLimitKey(
      run.runtimeEnvironment
    );

    const withPrefix = (key: string) => `engine:runqueue:${key}`;

    const keys = [
      {
        label: "Queue current concurrency set",
        key: withPrefix(queueCurrentConcurrencyKey),
      },
      {
        label: "Env current concurrency set",
        key: withPrefix(envCurrentConcurrencyKey),
      },
      {
        label: "Queue concurrency limit",
        key: withPrefix(queueConcurrencyLimitKey),
      },
      {
        label: "Env concurrency limit",
        key: withPrefix(envConcurrencyLimitKey),
      },
    ];

    return typedjson({
      engine: "V2",
      run,
      queueConcurrencyLimit,
      envConcurrencyLimit,
      queueCurrentConcurrency,
      envCurrentConcurrency,
      queueReserveConcurrency: undefined,
      envReserveConcurrency: undefined,
      keys,
    });
  }
}
