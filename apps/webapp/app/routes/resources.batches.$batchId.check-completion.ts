import { parseWithZod } from "@conform-to/zod";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";
import { runStore } from "~/v3/runStore.server";
import { findBatchRunIdForUser } from "~/v3/services/batchRunAccess.server";
import { tryCompleteBatchV3 } from "~/v3/services/batchTriggerV3.server";

export const checkCompletionSchema = z.object({
  redirectUrl: z.string(),
});

const ParamSchema = z.object({
  batchId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  // Require a logged-in user; org membership is checked below before resuming.
  const userId = await requireUserId(request);
  const { batchId } = ParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: checkCompletionSchema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  // Keep the post-action redirect same-origin.
  const safeRedirectUrl = sanitizeRedirectPath(submission.value.redirectUrl);

  // Only act on a batch in an org the caller belongs to. Accepts either the
  // friendlyId or the internal id; both forms stay org-scoped.
  const ownedBatchRunId = await findBatchRunIdForUser(prisma, runStore, batchId, userId);

  if (!ownedBatchRunId) {
    return redirectWithErrorMessage(safeRedirectUrl, request, "Batch not found");
  }

  try {
    // v3 (engine V1) is retired; finalize the batch through the v2 completion path (no-op if not ready).
    await tryCompleteBatchV3(ownedBatchRunId, prisma, true);

    return redirectWithSuccessMessage(safeRedirectUrl, request, "Batch completion checked.");
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to check batch completion", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return redirectWithErrorMessage(safeRedirectUrl, request, error.message);
    } else {
      logger.error("Failed to check batch completion", { error });
      return redirectWithErrorMessage(safeRedirectUrl, request, "Unknown error");
    }
  }
};
