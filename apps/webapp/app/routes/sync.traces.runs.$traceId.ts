import type { LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

const Params = z.object({
  traceId: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const userId = await getUserId(request);
    const { traceId } = Params.parse(params);

    logger.log(`/sync/runs/${traceId}`, { userId });

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
        traceId,
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

    originUrl.searchParams.set("where", `"traceId"='${traceId}'`);

    const finalUrl = originUrl.toString();

    logger.log("Fetching trace runs data", { url: finalUrl });

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
