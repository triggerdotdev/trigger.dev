import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { GetOrgsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createOrganization } from "~/models/organization.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const orgs = await prisma.organization.findMany({
      where: {
        deletedAt: null,
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
    });

    if (!orgs) {
      return json({ error: "Orgs not found" }, { status: 404 });
    }

    const result: GetOrgsResponseBody = orgs.map((org) => ({
      id: org.id,
      title: org.title,
      slug: org.slug,
      createdAt: org.createdAt,
    }));

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to list orgs", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const CreateOrgRequestBody = z.object({
  title: z.string().min(1),
  companySize: z.string().optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = CreateOrgRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    // Any authenticated user can create an org; the creator becomes its ADMIN.
    const organization = await createOrganization({
      title: body.data.title,
      companySize: body.data.companySize ?? null,
      userId: authenticationResult.userId,
    });

    return json(
      {
        id: organization.id,
        title: organization.title,
        slug: organization.slug,
        createdAt: organization.createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to create org", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
