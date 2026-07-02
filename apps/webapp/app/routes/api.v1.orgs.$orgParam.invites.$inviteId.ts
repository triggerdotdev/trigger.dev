import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { revokeInvite } from "~/models/member.server";
import { logger } from "~/services/logger.server";
import {
  authorizePatOrganizationAccess,
  resolveOrganizationForApiUser,
} from "~/services/organizationApiAccess.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
  inviteId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "DELETE") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { orgParam, inviteId } = parsedParams.data;

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

    const revoked = await revokeInvite({
      userId: authenticationResult.userId,
      orgSlug: organization.slug,
      inviteId,
    });

    return json({ id: inviteId, email: revoked.email });
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof Error && error.message === "Invite not found") {
      return json({ error: error.message }, { status: 404 });
    }
    logger.error("Failed to revoke invite", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
