import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunSpanPath } from "~/utils/pathBuilder";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  runParam: z.string(),
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

  const run = await runStore.findRun(
    {
      friendlyId: validatedParams.runParam,
    },
    {
      select: {
        friendlyId: true,
        spanId: true,
        runtimeEnvironmentId: true,
      },
    },
    prisma
  );

  if (!run) {
    throw new Response("Not found", { status: 404 });
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment) {
    throw new Response("Not found", { status: 404 });
  }

  // Redirect to the project's runs page
  return redirect(
    v3RunSpanPath({ slug: project.organization.slug }, { slug: project.slug }, environment, run, {
      spanId: run.spanId,
    })
  );
}
