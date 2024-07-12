import { type ActionFunction, LoaderFunction, type LoaderFunctionArgs, json } from "@remix-run/node";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  jsonWithErrorMessage,
  jsonWithSuccessMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { DeleteJobService } from "~/services/jobs/deleteJob.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";

const ParamSchema = z.object({
  jobId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { jobId } = ParamSchema.parse(params);

  const job = await prisma.job.findFirst({
    select: {
      id: true,
      slug: true,
      title: true,
      aliases: {
        select: {
          version: {
            select: {
              version: true,
              status: true,
              concurrencyLimit: true,
              concurrencyLimitGroup: {
                select: {
                  name: true,
                  concurrencyLimit: true,
                },
              },
              runs: {
                select: {
                  createdAt: true,
                  status: true,
                },
                take: 1,
                orderBy: [{ createdAt: "desc" }],
              },
            },
          },
          environment: {
            select: {
              type: true,
              orgMember: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
        where: {
          name: "latest",
        },
      },
    },
    where: {
      id: jobId,
      deletedAt: null,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
  });

  if (!job) {
    throw new Response("Not Found", { status: 404 });
  }

  const environments = job.aliases.map((alias) => ({
    type: alias.environment.type,
    enabled: alias.version.status === "ACTIVE",
    lastRun: alias.version.runs.at(0)?.createdAt,
    version: alias.version.version,
    concurrencyLimit: alias.version.concurrencyLimit,
    concurrencyLimitGroup: alias.version.concurrencyLimitGroup,
  }));

  return typedjson({
    environments,
  });
}

export const action: ActionFunction = async ({ request, params }) => {
  if (request.method.toUpperCase() !== "DELETE") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const { jobId } = ParamSchema.parse(params);
  const userId = await requireUserId(request);

  // Find the job
  const job = await prisma.job.findFirst({
    where: {
      id: jobId,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
  });

  if (!job) {
    return jsonWithErrorMessage({ ok: false }, request, `Job could not be scheduled for deletion.`);
  }
  try {
    const deleteJobService = new DeleteJobService();

    await deleteJobService.call(job);

    const url = new URL(request.url);
    const redirectTo = url.searchParams.get("redirectTo");

    logger.debug("Job scheduled for deletion", {
      url,
      redirectTo,
      job,
    });

    if (typeof redirectTo === "string" && redirectTo.length > 0) {
      return redirectWithSuccessMessage(
        redirectTo,
        request,
        `Job ${job.slug} has been scheduled for deletion.`
      );
    }

    return jsonWithSuccessMessage(
      { ok: true },
      request,
      `Job ${job.slug} has been scheduled for deletion.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return jsonWithErrorMessage(
      { ok: false },
      request,
      `Job could not be scheduled for deletion: ${message}`
    );
  }
};
