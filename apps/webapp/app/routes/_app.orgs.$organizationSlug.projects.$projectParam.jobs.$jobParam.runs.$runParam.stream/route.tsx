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

  if (run.completedAt) {
    return new Response(null, {
      status: 200,
    });
  }

  let stopped = false;

  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => {
    abortController.abort();
  });

  return eventStream(abortController.signal, (send) => {
    const pinger = setInterval(() => {
      send({ event: "ping", data: new Date().toISOString() });
    }, 1000);

    const interval = setInterval(() => {
      if (stopped) {
        abortController.abort();
        return;
      }

      runForUpdates(runParam)
        .then((run) => {
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
          abortController.abort();
        });
    }, 348);

    return function clear() {
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
