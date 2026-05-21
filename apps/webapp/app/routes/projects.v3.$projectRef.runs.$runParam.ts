import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunPath, v3RunSpanPath } from "~/utils/pathBuilder";
import { findBufferedRunRedirectInfo } from "~/v3/mollifier/syntheticRedirectInfo.server";

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
    // Fall back to the mollifier buffer so a /projects/v3/{ref}/runs/{id}
    // share link works during the buffered window.
    const buffered = await findBufferedRunRedirectInfo({
      runFriendlyId: validatedParams.runParam,
      userId,
    });
    if (buffered) {
      const url = new URL(request.url);
      const searchParams = url.searchParams;
      if (!searchParams.has("span") && buffered.spanId) {
        searchParams.set("span", buffered.spanId);
      }
      return redirect(
        v3RunPath(
          { slug: buffered.organizationSlug },
          { slug: buffered.projectSlug },
          { slug: buffered.environmentSlug },
          { friendlyId: validatedParams.runParam },
          searchParams
        )
      );
    }
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
