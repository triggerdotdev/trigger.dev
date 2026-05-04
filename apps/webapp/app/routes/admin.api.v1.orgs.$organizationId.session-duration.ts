import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  ALLOWED_SESSION_DURATION_VALUES,
  isAllowedSessionDuration,
} from "~/services/sessionDuration.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

const RequestBodySchema = z.object({
  /**
   * Maximum session lifetime (seconds) for members of this organization, or
   * null to remove the cap. When set, this caps each member's
   * `User.sessionDuration` and is enforced on the user's next request.
   *
   * Must be one of the values in `SESSION_DURATION_OPTIONS` so the cap always
   * maps to a labeled dropdown option for users — otherwise users see fallback
   * labels like "7200 seconds" in the UI. To allow a new value, add it to
   * `SESSION_DURATION_OPTIONS`.
   */
  maxSessionDuration: z
    .number()
    .int()
    .positive()
    .nullable()
    .refine((v) => v === null || isAllowedSessionDuration(v), {
      message: `maxSessionDuration must be one of: ${[...ALLOWED_SESSION_DURATION_VALUES]
        .sort((a, b) => a - b)
        .join(", ")}`,
    }),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json(
      { success: false, errors: { formErrors: ["Invalid JSON body"], fieldErrors: {} } },
      { status: 400 }
    );
  }
  const parseResult = RequestBodySchema.safeParse(rawBody);
  if (!parseResult.success) {
    return json({ success: false, errors: parseResult.error.flatten() }, { status: 400 });
  }
  const body = parseResult.data;

  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: { maxSessionDuration: body.maxSessionDuration },
    select: { id: true, slug: true, maxSessionDuration: true },
  });

  // Propagate the new cap to currently-logged-in members by shortening their
  // `nextSessionEnd`. We only ever shorten (`LEAST`): raising or removing the
  // cap leaves existing sessions alone — the larger window applies on next
  // login. If a member is in another org with a tighter cap that other cap
  // remains in effect via their existing `nextSessionEnd` (LEAST keeps it).
  if (body.maxSessionDuration !== null) {
    await prisma.$executeRaw`
      UPDATE "User"
      SET "nextSessionEnd" = LEAST(
        COALESCE("nextSessionEnd", 'infinity'::timestamp),
        NOW() + (LEAST("sessionDuration", ${body.maxSessionDuration}) * INTERVAL '1 second')
      )
      WHERE "id" IN (SELECT "userId" FROM "OrgMember" WHERE "organizationId" = ${organizationId})
    `;
  }

  return json({ success: true, organization });
}
