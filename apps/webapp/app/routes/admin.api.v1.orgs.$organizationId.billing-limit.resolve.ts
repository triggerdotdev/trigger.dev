import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { bustBillingLimitCaches } from "~/services/platform.v3.server";
import { logger } from "~/services/logger.server";
import { enqueueBillingLimitResolve } from "~/v3/billingLimitWorker.server";
import { processBillingLimitResolve } from "~/v3/services/billingLimit/billingLimitResolve.server";
import type { PendingBillingLimitResolve } from "~/v3/services/billingLimit/billingLimitPendingResolve.types";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const BodySchema = z.object({
  resumeMode: z.enum(["queue", "new_only"]),
  resolvedAt: z.string(),
});

/** Billing platform webhook: org resolved billing limit to ok. Idempotent — returns 202. */
export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method.toLowerCase() !== "post") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { id: true },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  let pending: PendingBillingLimitResolve;
  try {
    const body = await request.json();
    pending = {
      organizationId,
      ...BodySchema.parse(body),
    };
  } catch (error) {
    logger.error("Invalid billing limit resolve webhook payload", {
      error,
      organizationId,
    });
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    await processBillingLimitResolve(pending, {
      bustCaches: bustBillingLimitCaches,
      enqueueResolve: enqueueBillingLimitResolve,
    });
  } catch (error) {
    logger.error("Billing limit resolve webhook failed", {
      error,
      organizationId,
      resumeMode: pending.resumeMode,
      resolvedAt: pending.resolvedAt,
    });
    return json({ error: "Failed to process billing limit resolve" }, { status: 500 });
  }

  return json({ success: true, accepted: true }, { status: 202 });
}
