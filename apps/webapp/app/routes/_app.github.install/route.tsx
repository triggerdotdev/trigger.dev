import { redirect } from "remix-typedjson";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createGitHubAppInstallSession } from "~/services/gitHubSession.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { newOrganizationPath } from "~/utils/pathBuilder";
import { logger } from "~/services/logger.server";
import { sanitizeRedirectPath } from "~/utils";

const QuerySchema = z.object({
  org_slug: z.string(),
  redirect_to: z.string().refine((value) => value === sanitizeRedirectPath(value), {
    message: "Invalid redirect path",
  }),
});

async function resolveOrgIdFromSlug(slug: string): Promise<string | null> {
  const org = await $replica.organization.findFirst({ where: { slug }, select: { id: true } });
  return org?.id ?? null;
}

export const loader = dashboardLoader(
  {
    // The org for the auth scope comes from the `org_slug` query param.
    context: async (_params, request) => {
      const orgSlug = new URL(request.url).searchParams.get("org_slug");
      if (!orgSlug) return {};
      const organizationId = await resolveOrgIdFromSlug(orgSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "write", resource: { type: "github" } },
  },
  async ({ request, user }) => {
    const searchParams = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));

    if (!parsed.success) {
      logger.warn("GitHub App installation redirect with invalid params", {
        searchParams,
        error: parsed.error,
      });
      throw redirect("/");
    }

    const { org_slug, redirect_to } = parsed.data;

    const org = await $replica.organization.findFirst({
      where: { slug: org_slug, members: { some: { userId: user.id } }, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
      },
    });

    if (!org) {
      throw redirect(newOrganizationPath());
    }

    const { url, cookieHeader } = await createGitHubAppInstallSession(org.id, redirect_to);

    return redirect(url, {
      headers: {
        "Set-Cookie": cookieHeader,
      },
    });
  }
);
