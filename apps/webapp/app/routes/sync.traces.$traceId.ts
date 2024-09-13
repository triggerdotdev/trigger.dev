import type { LoaderFunctionArgs } from "@remix-run/node";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
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

    const finalUrl = originUrl.toString();

    logger.log("Fetching trace data", { url: finalUrl });

    return longPollingFetch(finalUrl);
  } catch (error) {
    if (error instanceof Response) {
      // Error responses from longPollingFetch
      return error;
    } else if (error instanceof TypeError) {
      // Unexpected errors
      logger.error("Unexpected error in loader:", { error: error.message });
      return new Response("An unexpected error occurred", { status: 500 });
    } else {
      // Unknown errors
      logger.error("Unknown error occurred in loader, not Error", { error: JSON.stringify(error) });
      return new Response("An unknown error occurred", { status: 500 });
    }
  }
}
