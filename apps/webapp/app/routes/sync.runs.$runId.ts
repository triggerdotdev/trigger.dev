import type { LoaderFunctionArgs } from "@remix-run/node";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);

  logger.log(`/sync/runs/${params.runId}`, { userId });

  if (!userId) {
    return new Response("No user found in cookie", { status: 401 });
  }

  const run = await $replica.taskRun.findFirst({
    select: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
    where: {
      id: params.runId,
    },
  });

  if (!run) {
    return new Response("No run found", { status: 404 });
  }

  const member = await $replica.orgMember.findFirst({
    where: {
      organizationId: run.project.organizationId,
      userId,
    },
  });

  if (!member) {
    return new Response("Not a member of this org", { status: 401 });
  }

  const url = new URL(request.url);
  const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskRun"`);
  url.searchParams.forEach((value, key) => {
    originUrl.searchParams.set(key, value);
  });

  originUrl.searchParams.set("where", `"id"='${params.runId}'`);

  return longPollingFetch(originUrl.toString());
}
