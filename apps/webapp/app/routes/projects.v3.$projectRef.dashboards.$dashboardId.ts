import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3CustomDashboardPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  projectRef: z.string(),
  dashboardId: z.string(),
});

const SearchParamsSchema = z.object({
  env: z.string().default("dev"),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { projectRef, dashboardId } = ParamsSchema.parse(params);
  const { env } = SearchParamsSchema.parse(Object.fromEntries(new URL(request.url).searchParams));

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      organization: { members: { some: { userId } } },
    },
    include: { organization: true },
  });

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  return redirect(
    v3CustomDashboardPath(
      { slug: project.organization.slug },
      { slug: project.slug },
      { slug: env },
      { friendlyId: dashboardId }
    )
  );
}
