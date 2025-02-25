import { LoaderFunctionArgs } from "@remix-run/node";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { marqs } from "~/v3/marqs/index.server";

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
  const envCurrentConcurrency = await marqs.currentConcurrencyOfEnvironment(run.runtimeEnvironment);

  const queueReserveConcurrency = await marqs.reserveConcurrencyOfQueue(
    run.runtimeEnvironment,
    run.queue,
    run.concurrencyKey ?? undefined
  );

  const envReserveConcurrency = await marqs.reserveConcurrencyOfEnvironment(run.runtimeEnvironment);

  return typedjson({
    run,
    queueConcurrencyLimit,
    envConcurrencyLimit,
    queueCurrentConcurrency,
    envCurrentConcurrency,
    queueReserveConcurrency,
    envReserveConcurrency,
  });
}
