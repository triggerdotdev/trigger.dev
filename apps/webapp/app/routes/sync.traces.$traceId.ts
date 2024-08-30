import type { LoaderFunctionArgs } from "@remix-run/node";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId, requireUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);

  logger.log(`/sync/traces/${params.traceId}`, { userId });

  if (!userId) {
    return new Response("No user found in cookie", { status: 401 });
  }

  const trace = await $replica.taskEvent.findFirst({
    select: {
      organizationId: true,
    },
    where: {
      traceId: params.traceId,
    },
  });

  if (!trace) {
    return new Response("No trace found", { status: 404 });
  }

  const member = await $replica.orgMember.findFirst({
    where: {
      organizationId: trace.organizationId,
      userId,
    },
  });

  if (!member) {
    return new Response("Not a member of this org", { status: 401 });
  }

  const url = new URL(request.url);
  const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskEvent"`);
  url.searchParams.forEach((value, key) => {
    originUrl.searchParams.set(key, value);
  });

  originUrl.searchParams.set("where", `"traceId"='${params.traceId}'`);

  return longPollingFetch(originUrl.toString());
}
