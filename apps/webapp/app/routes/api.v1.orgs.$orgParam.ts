import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { DeleteOrganizationService } from "~/services/deleteOrganization.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

const RenameOrgRequestBody = z.object({
  title: z.string().trim().min(3).max(50),
});

// Multi-method (PATCH rename / DELETE): declare both so other verbs 405, and
// the handler branches. No builder body schema — DELETE has none, so the PATCH
// branch parses its own body.
export const action = createActionPATApiRoute(
  {
    method: ["PATCH", "DELETE"],
    params: ParamsSchema,
    // Resolve the org (id only, no membership) so the plugin can compute the
    // caller's role floor for the manage:organization gate below.
    context: async ({ orgParam }) => {
      const org = await prisma.organization.findFirst({
        where: { OR: [{ id: orgParam }, { slug: orgParam }], deletedAt: null },
        select: { id: true },
      });
      return org ? { organizationId: org.id } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "organization" }) },
  },
  async ({ request, params, authentication }) => {
    // Membership floor: a non-member gets a 404 (the authorization block
    // enforces the role; this enforces membership).
    const organization = await resolveOrganizationForApiUser({
      orgParam: params.orgParam,
      userId: authentication.userId,
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    const method = request.method.toUpperCase();

    if (method === "DELETE") {
      try {
        await new DeleteOrganizationService().call({
          organizationSlug: organization.slug,
          userId: authentication.userId,
          request,
        });
      } catch (error) {
        // The service throws Errors with user-facing messages (active
        // subscription, already deleted, etc.).
        return json(
          { error: error instanceof Error ? error.message : "Failed to delete organization" },
          { status: 400 }
        );
      }

      return json({ id: organization.id });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = RenameOrgRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const updated = await prisma.organization.update({
      where: { id: organization.id },
      data: { title: body.data.title },
      select: { id: true, title: true, slug: true },
    });

    return json(updated);
  }
);
