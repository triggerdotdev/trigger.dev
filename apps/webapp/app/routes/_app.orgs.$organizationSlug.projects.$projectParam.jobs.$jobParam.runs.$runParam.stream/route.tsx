import type { LoaderArgs } from "@remix-run/server-runtime";
import { nanoid } from "nanoid";
import { eventStream } from "remix-utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { sse } from "~/utils/sse";

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

  return sse({
    request,
    run: async (send, stop) => {
      const result = await runForUpdates(runParam);
      if (!result) {
        return stop();
      }

      if (result.completedAt) {
        send({ data: new Date().toISOString() });
        return stop();
      }

      const totalRunUpdated = result.tasks.reduce(
        (prev, task) => prev + task.updatedAt.getTime(),
        0
      );

      if (lastUpdatedAt !== result.updatedAt.getTime()) {
        send({ data: result.updatedAt.toISOString() });
      } else if (lastTotalTaskUpdatedTime !== totalRunUpdated) {
        send({ data: new Date().toISOString() });
      }

      lastUpdatedAt = result.updatedAt.getTime();
      lastTotalTaskUpdatedTime = totalRunUpdated;
    },
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
