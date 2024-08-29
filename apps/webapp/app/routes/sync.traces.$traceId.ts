import type { LoaderFunctionArgs } from "@remix-run/node";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId, requireUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);

  logger.log(`/sync/traces/${params.traceId}`, { userId });

  if (!userId) {
    return new Response("authorization header not found", { status: 401 });
  }

  //todo check the user has access to this trace

  const url = new URL(request.url);
  const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskEvent"`);
  url.searchParams.forEach((value, key) => {
    originUrl.searchParams.set(key, value);
  });

  originUrl.searchParams.set("where", `"traceId"='${params.traceId}'`);

  return longPollingFetch(originUrl.toString());
}
