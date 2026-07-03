import { type LoaderFunctionArgs } from "@remix-run/node";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

const ParamSchema = z.object({
  runParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { runParam } = ParamSchema.parse(params);

  // Run-ops read keyed by friendlyId only (routes to the owning DB by residency). The
  // project/org-membership auth is a control-plane concern resolved separately below —
  // joining it here is a cross-DB join that returns nothing once the run lives in run-ops.
  const run = await runStore.findRun(
    { friendlyId: runParam },
    {
      select: {
        id: true,
        engine: true,
        friendlyId: true,
        queue: true,
        concurrencyKey: true,
        queueTimestamp: true,
        runtimeEnvironmentId: true,
        projectId: true,
      },
    }
  );

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  // Authorize on the control-plane DB, keyed by the run's project — a non-member (or
  // unresolvable project) is indistinguishable from not-found (both 404), matching the
  // original scoped where.
  const authorizedProject = await prisma.project.findFirst({
    where: { id: run.projectId, organization: { members: { some: { userId } } } },
    select: { id: true },
  });

  if (!authorizedProject) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  if (run.engine === "V1") {
    const queueConcurrencyLimit = await marqs.getQueueConcurrencyLimit(environment, run.queue);
    const envConcurrencyLimit = await marqs.getEnvConcurrencyLimit(environment);
    const queueCurrentConcurrency = await marqs.currentConcurrencyOfQueue(
      environment,
      run.queue,
      run.concurrencyKey ?? undefined
    );
    const envCurrentConcurrency = await marqs.currentConcurrencyOfEnvironment(environment);

    const queueReserveConcurrency = await marqs.reserveConcurrencyOfQueue(
      environment,
      run.queue,
      run.concurrencyKey ?? undefined
    );

    const envReserveConcurrency = await marqs.reserveConcurrencyOfEnvironment(environment);

    return typedjson({
      engine: "V1",
      run,
      environment,
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
      environment,
      run.queue
    );

    const envConcurrencyLimit = await engine.runQueue.getEnvConcurrencyLimit(environment);

    const queueCurrentConcurrency = await engine.runQueue.currentConcurrencyOfQueue(
      environment,
      run.queue,
      run.concurrencyKey ?? undefined
    );

    const envCurrentConcurrency =
      await engine.runQueue.currentConcurrencyOfEnvironment(environment);

    const queueCurrentConcurrencyKey = engine.runQueue.keys.queueCurrentConcurrencyKey(
      environment,
      run.queue,
      run.concurrencyKey ?? undefined
    );

    const envCurrentConcurrencyKey = engine.runQueue.keys.envCurrentConcurrencyKey(environment);

    const queueConcurrencyLimitKey = engine.runQueue.keys.queueConcurrencyLimitKey(
      environment,
      run.queue
    );

    const envConcurrencyLimitKey = engine.runQueue.keys.envConcurrencyLimitKey(environment);

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
      environment,
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
