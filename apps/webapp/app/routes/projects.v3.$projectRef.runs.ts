import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { type EnvSlug, isEnvSlug } from "~/models/api-key.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { projectRef } = ParamsSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
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
    return new Response("Project not found", { status: 404 });
  }

  const url = new URL(request.url);
  const envSlug = url.searchParams.get("envSlug");

  // Get the environment from the slug
  if (envSlug && isEnvSlug(envSlug)) {
    const env = await getEnvFromSlug(project.id, userId, envSlug);

    if (env) {
      return redirect(
        `/orgs/${project.organization.slug}/projects/${project.slug}/env/${envSlug}/runs${url.search}`
      );
    }
  }

  return redirect(`/orgs/${project.organization.slug}/projects/${project.slug}`);
}

async function getEnvFromSlug(projectId: string, userId: string, envSlug: EnvSlug) {
  if (envSlug === "dev") {
    return await prisma.runtimeEnvironment.findFirst({
      where: {
        projectId,
        slug: envSlug,
        orgMember: {
          userId,
        },
      },
    });
  }

  return await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId,
      slug: envSlug,
    },
  });
}
