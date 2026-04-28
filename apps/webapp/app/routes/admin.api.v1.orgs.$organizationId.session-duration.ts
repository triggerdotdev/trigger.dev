import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const RequestBodySchema = z.object({
  /**
   * Maximum session lifetime (seconds) for members of this organization, or
   * null to remove the cap. When set, this caps each member's
   * `User.sessionDuration` and is enforced on the user's next request.
   */
  maxSessionDuration: z.number().int().positive().nullable(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);
  const body = RequestBodySchema.parse(await request.json());

  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: { maxSessionDuration: body.maxSessionDuration },
    select: { id: true, slug: true, maxSessionDuration: true },
  });

  return json({ success: true, organization });
}
