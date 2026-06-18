import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { runStore } from "~/v3/runStore.server";

export const cancelSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  runParam: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { runParam } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: cancelSchema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const taskRun = await runStore.findRun(
      {
        friendlyId: runParam,
        project: {
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
      prisma
    );

    if (taskRun) {
      const cancelRunService = new CancelTaskRunService();
      await cancelRunService.call(taskRun);
      return redirectWithSuccessMessage(submission.value.redirectUrl, request, `Canceled run`);
    }

    // PG miss — try the mollifier buffer. The customer can hit cancel
    // on a buffered run from the dashboard during the burst window.
    // Snapshot a `mark_cancelled` patch; the drainer's
    // bifurcation routes the run to `engine.createCancelledRun` on
    // next pop.
    const buffer = getMollifierBuffer();
    const entry = buffer ? await buffer.getEntry(runParam) : null;
    if (!entry) {
      submission.error = { runParam: ["Run not found"] };
      return json(submission);
    }

    // Dashboard auth: verify the requesting user is a member of the
    // buffered run's org. The API path scopes by env id from the
    // authenticated request; the dashboard route uses org-membership
    // because the URL doesn't carry an envId.
    const member = await prisma.orgMember.findFirst({
      where: { userId, organizationId: entry.orgId },
      select: { id: true },
    });
    if (!member) {
      submission.error = { runParam: ["Run not found"] };
      return json(submission);
    }

    const result = await buffer!.mutateSnapshot(runParam, {
      type: "mark_cancelled",
      cancelledAt: new Date().toISOString(),
      cancelReason: "Canceled by user",
    });
    if (result === "applied_to_snapshot") {
      return redirectWithSuccessMessage(submission.value.redirectUrl, request, `Canceled run`);
    }
    // "not_found" or "busy" — both indicate the drainer raced us between
    // the getEntry check above and mutateSnapshot. On "not_found" the
    // entry was just popped and the PG row is in flight; on "busy" the
    // drainer is mid-materialisation. Either way the customer should
    // retry — by then the PG row exists and the regular cancel path at
    // the top of this action takes over.
    return redirectWithErrorMessage(
      submission.value.redirectUrl,
      request,
      "Run is materialising — retry in a moment"
    );
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to cancel run", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(
        submission.value.redirectUrl,
        request,
        `Failed to cancel run, ${error.message}`
      );
    } else {
      logger.error("Failed to cancel run", { error });
      return redirectWithErrorMessage(
        submission.value.redirectUrl,
        request,
        `Failed to cancel run, ${JSON.stringify(error)}`
      );
    }
  }
};
