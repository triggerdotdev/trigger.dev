import { parse } from "@conform-to/zod";
import { type ActionFunctionArgs } from "@remix-run/router";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import { CreateBulkActionService } from "~/v3/services/bulk/createBulkAction.server";

const FormSchema = z.object({
  organizationSlug: z.string(),
  projectSlug: z.string(),
  environmentSlug: z.string(),
  failedRedirect: z.string(),
  runIds: z.array(z.string()).or(z.string()),
});

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage("/", request, "Invalid method");
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema: FormSchema });

  if (!submission.value) {
    logger.error("Failed to parse resources/taskruns/bulk/cancel form data", { submission });
    return redirectWithErrorMessage("/", request, "Failed to parse form data");
  }

  try {
    const project = await prisma.project.findUnique({
      where: {
        slug: submission.value.projectSlug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      return redirectWithErrorMessage(
        submission.value.failedRedirect,
        request,
        "Project not found"
      );
    }

    const service = new CreateBulkActionService();
    const result = await service.call({
      projectId: project.id,
      action: "CANCEL",
      runIds:
        typeof submission.value.runIds === "string"
          ? [submission.value.runIds]
          : submission.value.runIds,
    });

    const path = v3RunsPath(
      { slug: submission.value.organizationSlug },
      { slug: project.slug },
      { slug: submission.value.environmentSlug },
      {
        bulkId: result.friendlyId,
      }
    );

    return redirectWithSuccessMessage(path, request, result.message);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to cancel runs", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(submission.value.failedRedirect, request, error.message);
    } else {
      logger.error("Failed to cancel runs", { error });
      return redirectWithErrorMessage(
        submission.value.failedRedirect,
        request,
        JSON.stringify(error)
      );
    }
  }
}
