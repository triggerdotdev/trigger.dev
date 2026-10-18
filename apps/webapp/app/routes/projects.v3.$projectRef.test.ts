import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3ProjectPath, v3TestPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

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
  const environment = url.searchParams.get("environment");
  const branch = sanitizeBranchName(url.searchParams.get("branch"));

  if (environment) {
    // The CLI links preview deploys by branch name. Branch environments have their own slug.
    const branchEnvironment = branch
      ? await prisma.runtimeEnvironment.findFirst({
          select: { slug: true },
          where: {
            projectId: project.id,
            branchName: branch,
            archivedAt: null,
            parentEnvironment: { slug: environment, type: "PREVIEW" },
          },
        })
      : null;

    return redirect(
      v3TestPath(
        { slug: project.organization.slug },
        { slug: project.slug },
        { slug: branchEnvironment?.slug ?? environment }
      )
    );
  }

  return redirect(v3ProjectPath({ slug: project.organization.slug }, { slug: project.slug }));
}
