import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { logger } from "~/services/logger.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { generateVercelOAuthState } from "~/v3/vercel/vercelOAuthState.server";
import { findProjectBySlug } from "~/models/project.server";

const QuerySchema = z.object({
  org_slug: z.string(),
  project_slug: z.string(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const searchParams = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    logger.warn("Vercel App installation redirect with invalid params", {
      searchParams,
      error: parsed.error,
    });
    throw redirect("/");
  }

  const { org_slug, project_slug } = parsed.data;
  const user = await requireUser(request);

  // Find the organization
  const org = await $replica.organization.findFirst({
    where: { slug: org_slug, members: { some: { userId: user.id } }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
    },
  });

  if (!org) {
    throw redirect("/");
  }

  // Find the project
  const project = await findProjectBySlug(org_slug, project_slug, user.id);
  if (!project) {
    logger.warn("Vercel App installation attempt for non-existent project", {
      org_slug,
      project_slug,
      userId: user.id,
    });
    throw redirect("/");
  }

  // Use "prod" as the default environment slug for the redirect
  // The callback will redirect to the settings page for this environment
  const environmentSlug = "prod";

  // Generate JWT state token
  const stateToken = await generateVercelOAuthState({
    organizationId: org.id,
    projectId: project.id,
    environmentSlug,
    organizationSlug: org_slug,
    projectSlug: project_slug,
  });

  // Generate Vercel install URL
  const vercelInstallUrl = OrgIntegrationRepository.vercelInstallUrl(stateToken);

  return redirect(vercelInstallUrl);
};

