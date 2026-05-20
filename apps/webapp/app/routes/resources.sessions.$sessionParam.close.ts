import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";

export const closeSessionSchema = z.object({
  redirectUrl: z.string(),
  environmentId: z.string(),
  reason: z.string().optional(),
});

const ParamSchema = z.object({
  sessionParam: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { sessionParam } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: closeSessionSchema });

  if (!submission.value) {
    return json(submission);
  }

  const { redirectUrl, environmentId, reason } = submission.value;
  const trimmedReason = reason?.trim();
  const closedReason =
    trimmedReason && trimmedReason.length > 0 ? trimmedReason : "closed-from-dashboard";

  try {
    // Confirm the user belongs to the org that owns this environment, then
    // resolve the session by friendlyId or externalId scoped to that env.
    const environment = await $replica.runtimeEnvironment.findFirst({
      where: {
        id: environmentId,
        organization: { members: { some: { userId } } },
      },
      select: { id: true },
    });

    if (!environment) {
      submission.error = { environmentId: ["Environment not found"] };
      return json(submission);
    }

    const session = await resolveSessionByIdOrExternalId(
      $replica,
      environment.id,
      sessionParam
    );

    if (!session) {
      submission.error = { sessionParam: ["Session not found"] };
      return json(submission);
    }

    if (session.closedAt) {
      // Already closed — no-op, but redirect with a friendly message so the
      // UI doesn't look like it did nothing.
      return redirectWithSuccessMessage(redirectUrl, request, `Session already closed`);
    }

    // Conditional update mirrors the public API: two concurrent closes race
    // through the read but only one wins this update.
    await prisma.session.updateMany({
      where: { id: session.id, closedAt: null },
      data: {
        closedAt: new Date(),
        closedReason,
      },
    });

    return redirectWithSuccessMessage(redirectUrl, request, `Closed session`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to close session", {
        error: { name: error.name, message: error.message, stack: error.stack },
      });
      return redirectWithErrorMessage(
        redirectUrl,
        request,
        `Failed to close session, ${error.message}`
      );
    }
    logger.error("Failed to close session", { error });
    return redirectWithErrorMessage(
      redirectUrl,
      request,
      `Failed to close session, ${JSON.stringify(error)}`
    );
  }
};
