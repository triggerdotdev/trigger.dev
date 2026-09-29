import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { activateFreePlan } from "~/services/platform.v3.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: ParamsSchema,
    context: async ({ orgParam }) => {
      const organization = await prisma.organization.findFirst({
        where: { OR: [{ id: orgParam }, { slug: orgParam }], deletedAt: null },
        select: { id: true },
      });
      return organization ? { organizationId: organization.id } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "billing" }) },
  },
  async ({ params, authentication }) => {
    if (env.ORG_CREATION_API_ENABLED !== "1") {
      return json({ error: "Not found" }, { status: 404 });
    }

    const organization = await resolveOrganizationForApiUser({
      orgParam: params.orgParam,
      userId: authentication.userId,
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    if (organization.isActivated) {
      return json({ error: "Organization is already activated" }, { status: 409 });
    }

    const result = await activateFreePlan(organization.id, authentication.userId, {
      invalidateBillingCache: engine.invalidateBillingCache.bind(engine),
    });

    if (!result.success) {
      return json({ error: "Failed to activate Free plan" }, { status: 502 });
    }

    return json({ plan: "free" as const });
  }
);
