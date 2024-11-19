import type { LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getUserId } from "~/services/session.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

const Params = z.object({
  projectId: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const userId = await getUserId(request);
    const { projectId } = Params.parse(params);

    logger.log(`/sync/${projectId}/runs`, { userId, projectId });

    if (!userId) {
      return new Response("No user found in cookie", { status: 401 });
    }

    const project = await $replica.project.findFirst({
      select: {
        organization: {
          select: {
            members: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
      where: {
        id: projectId,
      },
    });

    if (!project) {
      return new Response("No project found", { status: 404 });
    }

    const isMember = project.organization.members.some((member) => member.userId === userId);

    if (!isMember) {
      return new Response("Not a member of this org", { status: 401 });
    }

    const url = new URL(request.url);
    const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskRun"`);
    url.searchParams.forEach((value, key) => {
      originUrl.searchParams.set(key, value);
    });

    originUrl.searchParams.set("where", `"projectId"='${projectId}'`);

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
