import type { LoaderArgs } from "@remix-run/server-runtime";
import { nanoid } from "nanoid";
import { eventStream } from "remix-utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  await requireUserId(request);

  const { runParam } = z.object({ runParam: z.string() }).parse(params);

  const run = await runForUpdates(runParam);

  if (!run) {
    return new Response("Not found", { status: 404 });
  }

  let lastUpdatedAt: number = run.updatedAt.getTime();
  let lastTotalTaskUpdatedTime = run.tasks.reduce(
    (prev, task) => prev + task.updatedAt.getTime(),
    0
  );

  let stopped = false;

  return eventStream(request.signal, (send) => {
    const pinger = setInterval(() => {
      if (stopped) return;
      send({ event: "ping", data: new Date().toISOString() });
    }, 1000);

    const interval = setInterval(() => {
      if (stopped) return;
      runForUpdates(runParam)
        .then((run) => {
          if (stopped) return;
          if (!run) return;

          if (run.completedAt) {
            stopped = true;
            return send({
              event: "update",
              data: run.completedAt.toISOString(),
            });
          }

          const totalRunUpdated = run.tasks.reduce(
            (prev, task) => prev + task.updatedAt.getTime(),
            0
          );

          if (lastUpdatedAt !== run.updatedAt.getTime()) {
            send({ event: "update", data: run.updatedAt.toISOString() });
          } else if (lastTotalTaskUpdatedTime !== totalRunUpdated) {
            send({ event: "update", data: nanoid() });
          }

          lastUpdatedAt = run.updatedAt.getTime();
          lastTotalTaskUpdatedTime = totalRunUpdated;
        })
        .catch(() => {
          stopped = true;
        });
    }, 348);

    return function clear() {
      stopped = true;
      clearInterval(pinger);
      clearInterval(interval);
    };
  });
}

function runForUpdates(id: string) {
  return prisma.jobRun.findUnique({
    where: {
      id,
    },
    select: {
      updatedAt: true,
      completedAt: true,
      tasks: {
        select: {
          updatedAt: true,
        },
      },
    },
  });
}
