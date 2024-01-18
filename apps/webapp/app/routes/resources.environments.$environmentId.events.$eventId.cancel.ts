import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { CancelEventService } from "~/services/events/cancelEvent.server";
import { prisma } from "~/db.server";

export const cancelEventSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  environmentId: z.string(),
  eventId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const { environmentId, eventId } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: cancelEventSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const environment = await prisma.runtimeEnvironment.findUnique({
      include: {
        organization: true,
        project: true,
      },
      where: {
        id: environmentId,
      },
    });

    if (!environment) {
      return json({ errors: { body: "Environment not found" } }, { status: 404 });
    }

    const cancelEventService = new CancelEventService();
    await cancelEventService.call(environment, eventId);

    return redirectWithSuccessMessage(submission.value.redirectUrl, request, `Cancelled event.`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to cancel event", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return json({ errors: { body: error.message } }, { status: 400 });
    } else {
      logger.error("Failed to cancel event", { error });
      return json({ errors: { body: "Unknown error" } }, { status: 400 });
    }
  }
};
