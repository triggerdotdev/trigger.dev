import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { removeTeamMember } from "~/models/member.server";
import { logger } from "~/services/logger.server";
import {
  authorizePatOrganizationAccess,
  resolveOrganizationForApiUser,
} from "~/services/organizationApiAccess.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
  memberId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "DELETE") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { orgParam, memberId } = parsedParams.data;

  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const organization = await resolveOrganizationForApiUser({
      orgParam,
      userId: authenticationResult.userId,
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    const denied = await authorizePatOrganizationAccess({
      request,
      organizationId: organization.id,
      resource: "members",
      action: "manage",
    });
    if (denied) return denied;

    // An org must keep at least one member. The dashboard guards this in the
    // UI only; enforce it here since removeTeamMember doesn't.
    const memberCount = await prisma.orgMember.count({
      where: { organizationId: organization.id },
    });
    if (memberCount <= 1) {
      return json({ error: "Cannot remove the last member of an organization" }, { status: 400 });
    }

    const removed = await removeTeamMember({
      userId: authenticationResult.userId,
      slug: organization.slug,
      memberId,
    });

    return json({
      id: removed.id,
      user: {
        id: removed.user.id,
        name: removed.user.name,
        email: removed.user.email,
      },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof Error && error.message === "Member not found in this organization") {
      return json({ error: error.message }, { status: 404 });
    }
    logger.error("Failed to remove org member", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
