import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { getTeamMembersAndInvites } from "~/models/member.server";
import { logger } from "~/services/logger.server";
import {
  authorizePatOrganizationAccess,
  resolveOrganizationForApiUser,
} from "~/services/organizationApiAccess.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const organization = await resolveOrganizationForApiUser({
      orgParam: parsedParams.data.orgParam,
      userId: authenticationResult.userId,
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    const denied = await authorizePatOrganizationAccess({
      request,
      organizationId: organization.id,
      resource: "members",
      action: "read",
    });
    if (denied) return denied;

    const result = await getTeamMembersAndInvites({
      userId: authenticationResult.userId,
      organizationId: organization.id,
    });

    if (!result) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    return json({
      members: result.members.map((member) => ({
        id: member.id,
        role: member.role,
        user: {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          avatarUrl: member.user.avatarUrl,
        },
      })),
      invites: result.invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        updatedAt: invite.updatedAt,
        inviter: {
          id: invite.inviter.id,
          name: invite.inviter.name,
          email: invite.inviter.email,
        },
      })),
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to list org members", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
