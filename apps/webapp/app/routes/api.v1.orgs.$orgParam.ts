import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { DeleteOrganizationService } from "~/services/deleteOrganization.server";
import { logger } from "~/services/logger.server";
import {
  authorizePatOrganizationAccess,
  resolveOrganizationForApiUser,
} from "~/services/organizationApiAccess.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

const RenameOrgRequestBody = z.object({
  title: z.string().min(1),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const method = request.method.toUpperCase();
  if (method !== "DELETE" && method !== "PATCH") {
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

    // Rename/delete are Owner-only (via manage:all). Membership resolution above
    // is the OSS floor; this is the role gate enforced when the RBAC plugin runs.
    const denied = await authorizePatOrganizationAccess({
      request,
      organizationId: organization.id,
      resource: "organization",
      action: "manage",
    });
    if (denied) {
      return denied;
    }

    if (method === "DELETE") {
      try {
        await new DeleteOrganizationService().call({
          organizationSlug: organization.slug,
          userId: authenticationResult.userId,
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
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to update organization", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
