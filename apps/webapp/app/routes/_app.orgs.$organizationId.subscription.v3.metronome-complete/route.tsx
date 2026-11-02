import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { z } from "zod";
import { prisma } from "~/db.server";
import { billingPlugin } from "~/services/billingPlugin.server";
import { clearCachesAfterPlanCheckout } from "~/services/planCheckoutCaches.server";
import { invalidatePlanDerivedCaches } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

async function isMember(userId: string, organizationId: string): Promise<boolean> {
  const org = await prisma.organization.findFirst({
    select: { id: true },
    where: { id: organizationId, members: { some: { userId } } },
  });
  return org !== null;
}

// Billing sends a completed Metronome card checkout here, then on to the usual completion page.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationId } = ParamsSchema.parse(params);

  const cleared = await clearCachesAfterPlanCheckout(organizationId, userId, {
    isMember,
    invalidatePlanCaches: invalidatePlanDerivedCaches,
    usage: billingPlugin,
  });
  if (!cleared) throw new Response(null, { status: 404 });

  return redirect(`/orgs/${organizationId}/subscription/v3/complete`);
};
