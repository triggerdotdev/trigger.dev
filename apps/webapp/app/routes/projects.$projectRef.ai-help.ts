import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  aiHelpDocsUrl,
  aiHelpRedirectUrl,
  askAiCanOpen,
} from "~/components/dashboard-agent/ask-ai-channels";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { featuresForRequest } from "~/features.server";
import { hasAdminDisplayAccess, requireUser } from "~/services/session.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const userId = user.id;

  const validatedParams = ParamsSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      externalRef: validatedParams.projectRef,
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q");

  if (!query) {
    return new Response("No query", { status: 400 });
  }

  const showAdminUi = hasAdminDisplayAccess(user);
  const canOpenSomething =
    askAiCanOpen({
      isManagedCloud: featuresForRequest(request).isManagedCloud,
      kapaWebsiteId: env.KAPA_AI_WEBSITE_ID,
    }) ||
    (await canAccessDashboardAgent({
      userId,
      isAdmin: showAdminUi && user.admin,
      isImpersonating: showAdminUi && user.isImpersonating,
      organizationSlug: project.organization.slug,
      orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    }));

  if (!canOpenSomething) {
    return redirect(aiHelpDocsUrl(query));
  }

  return redirect(
    aiHelpRedirectUrl({
      environmentPath: v3EnvironmentPath(
        { slug: project.organization.slug },
        { slug: project.slug },
        { slug: "dev" }
      ),
      origin: env.LOGIN_ORIGIN,
      query,
    })
  );
}
