import { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { WEBHOOK_LIMITS_INTENT } from "./WebhookLimitsSection";

const OptionalLimit = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.coerce.number().int().min(1).max(2_147_483_647).optional()
);

const SetWebhookLimitsSchema = z.object({
  intent: z.literal(WEBHOOK_LIMITS_INTENT),
  maxWaitersPerEnvironment: OptionalLimit,
  maxWaitersPerEndpoint: OptionalLimit,
  concurrency: OptionalLimit,
});

export type WebhookLimitsActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string[] | undefined> };

export async function handleWebhookLimitsAction(
  formData: FormData,
  orgId: string,
  adminUserId: string
): Promise<WebhookLimitsActionResult> {
  const submission = SetWebhookLimitsSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return { ok: false, errors: submission.error.flatten().fieldErrors };
  }

  const existing = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { webhookLimitsConfig: true },
  });
  if (!existing) {
    throw new Response(null, { status: 404 });
  }

  const { intent: _intent, ...values } = submission.data;
  const next = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  );

  await prisma.organization.update({
    where: { id: orgId },
    data: { webhookLimitsConfig: Object.keys(next).length > 0 ? next : Prisma.DbNull },
  });

  logger.info("admin.backOffice.webhookLimits", {
    adminUserId,
    orgId,
    previous: existing.webhookLimitsConfig,
    next,
  });

  return { ok: true };
}
