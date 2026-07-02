import { parseWithZod } from "@conform-to/zod";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { getCurrentPlan, getSelfServePurchaseBlockReason } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { SetSchedulesAddOnService } from "~/v3/services/setSchedulesAddOn.server";

export const PurchaseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("purchase"),
    amount: z.coerce.number().int("Must be a whole number").min(0, "Amount must be 0 or more"),
  }),
  z.object({
    action: z.literal("quota-increase"),
    amount: z.coerce.number().int("Must be a whole number").min(1, "Amount must be greater than 0"),
  }),
]);

const ParamsSchema = z.object({ organizationSlug: z.string() });

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
    select: { id: true },
  });
  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  const currentPlan = await getCurrentPlan(organization.id);
  const purchaseBlockReason = getSelfServePurchaseBlockReason(currentPlan);
  if (purchaseBlockReason === "plan_unavailable") {
    return json(
      { ok: false, error: "Unable to verify billing status. Please try again." } as const,
      { status: 503 }
    );
  }
  if (purchaseBlockReason === "managed_billing") {
    return json({ ok: false, error: "Contact us to request more schedules." } as const, {
      status: 403,
    });
  }

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: PurchaseSchema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  const service = new SetSchedulesAddOnService();
  const [error, result] = await tryCatch(
    service.call({
      userId,
      organizationId: organization.id,
      action: submission.value.action,
      amount: submission.value.amount,
    })
  );

  if (error) {
    return json(
      submission.reply({
        fieldErrors: { amount: [error instanceof Error ? error.message : "Unknown error"] },
      })
    );
  }

  if (!result.success) {
    return json(submission.reply({ fieldErrors: { amount: [result.error] } }));
  }

  return json({ ok: true } as const);
}
