import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunSpanPath } from "~/utils/pathBuilder";

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

  const run = await prisma.taskRun.findUnique({
    where: {
      friendlyId: validatedParams.runParam,
    },
    include: {
      runtimeEnvironment: true,
    },
  });

  if (!run) {
    throw new Response("Not found", { status: 404 });
  }

  // Redirect to the project's runs page
  return redirect(
    v3RunSpanPath(
      { slug: project.organization.slug },
      { slug: project.slug },
      run.runtimeEnvironment,
      run,
      {
        spanId: run.spanId,
      }
    )
  );
}
