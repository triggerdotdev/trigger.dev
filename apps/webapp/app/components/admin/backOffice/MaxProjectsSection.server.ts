import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { MAX_PROJECTS_INTENT } from "./MaxProjectsSection";

const SetMaxProjectsSchema = z.object({
  intent: z.literal(MAX_PROJECTS_INTENT),
  maximumProjectCount: z.coerce.number().int().min(1),
});

export type MaxProjectsActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string[] | undefined> };

export async function handleMaxProjectsAction(
  formData: FormData,
  orgId: string,
  adminUserId: string
): Promise<MaxProjectsActionResult> {
  const submission = SetMaxProjectsSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return { ok: false, errors: submission.error.flatten().fieldErrors };
  }

  const existing = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { maximumProjectCount: true },
  });
  if (!existing) {
    throw new Response(null, { status: 404 });
  }

  await prisma.organization.update({
    where: { id: orgId },
    data: { maximumProjectCount: submission.data.maximumProjectCount },
  });

  logger.info("admin.backOffice.maxProjects", {
    adminUserId,
    orgId,
    previous: existing.maximumProjectCount,
    next: submission.data.maximumProjectCount,
  });

  return { ok: true };
}
