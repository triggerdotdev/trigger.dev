import { json } from "@remix-run/server-runtime";
import type { GetOrgsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createOrganization } from "~/models/organization.server";
import {
  createActionPATApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

// Identity-only: lists the caller's own orgs, so no authorization gate.
export const loader = createLoaderPATApiRoute({}, async ({ authentication }) => {
  const orgs = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      members: {
        some: {
          userId: authentication.userId,
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
});

const CreateOrgRequestBody = z.object({
  title: z.string().min(1),
  companySize: z.string().optional(),
});

// No org exists yet, so no authorization gate; any authenticated user can
// create an org and becomes its ADMIN.
export const action = createActionPATApiRoute(
  {
    method: "POST",
    body: CreateOrgRequestBody,
  },
  async ({ body, authentication }) => {
    const organization = await createOrganization({
      title: body.title,
      companySize: body.companySize ?? null,
      userId: authentication.userId,
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
  }
);
