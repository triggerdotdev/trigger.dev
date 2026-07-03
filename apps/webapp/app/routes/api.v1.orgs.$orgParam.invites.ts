import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { inviteMembers } from "~/models/member.server";
import { logger } from "~/services/logger.server";
import {
  authorizePatOrganizationAccess,
  resolveOrganizationForApiUser,
} from "~/services/organizationApiAccess.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
import { acceptInvitePath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

const InviteRequestBody = z.object({
  emails: z.string().email().array().nonempty("At least one email is required"),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

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
      action: "manage",
    });
    if (denied) return denied;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = InviteRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const invites = await inviteMembers({
      slug: organization.slug,
      emails: body.data.emails,
      userId: authenticationResult.userId,
    });

    // Send invite emails the same way the dashboard invite action does. A
    // failed send must not fail the invite (the row already exists); in local
    // dev with no SMTP config, scheduleEmail's transport logs instead.
    for (const invite of invites) {
      try {
        await scheduleEmail({
          email: "invite",
          to: invite.email,
          orgName: invite.organization.title,
          inviterName: invite.inviter.name ?? undefined,
          inviterEmail: invite.inviter.email,
          inviteLink: `${env.LOGIN_ORIGIN}${acceptInvitePath(invite.token)}`,
        });
      } catch (error) {
        logger.error("Failed to send invite email", { error });
      }
    }

    return json(
      {
        invites: invites.map((invite) => ({ id: invite.id, email: invite.email })),
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to invite org members", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
