import { json } from "@remix-run/server-runtime";
import type { GetOrgsResponseBody } from "@trigger.dev/core/v3";
import { CreateOrgRequestBody } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { createOrganization } from "~/models/organization.server";
import {
  createActionPATApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { extractDomain, faviconUrl } from "~/utils/favicon";

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

// No org exists yet, so no authorization gate; any authenticated user can
// create an org and becomes its ADMIN.
export const action = createActionPATApiRoute(
  {
    method: "POST",
    body: CreateOrgRequestBody,
  },
  async ({ body, authentication }) => {
    if (env.ORG_CREATION_API_ENABLED !== "1") {
      return json({ error: "Not found" }, { status: 404 });
    }

    // Mirror the dashboard: stash companyUrl/companySize as onboarding data and
    // derive the org avatar from the company domain's favicon.
    const onboardingData: Record<string, string> = {};
    if (body.companyUrl) {
      onboardingData.companyUrl = body.companyUrl;
    }
    if (body.companySize) {
      onboardingData.companySize = body.companySize;
    }

    let avatar: { type: "image"; url: string } | undefined;
    if (body.companyUrl) {
      const domain = extractDomain(body.companyUrl);
      if (domain) {
        avatar = { type: "image", url: faviconUrl(domain) };
      }
    }

    const organization = await createOrganization({
      title: body.title,
      companySize: body.companySize ?? null,
      userId: authentication.userId,
      onboardingData: Object.keys(onboardingData).length > 0 ? onboardingData : undefined,
      avatar,
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
