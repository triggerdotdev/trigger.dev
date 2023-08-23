import { ActionFunction } from "@remix-run/node";
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

export const action: ActionFunction = async ({ request, params }) => {
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
