import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { rootPath, v3RunPath } from "~/utils/pathBuilder";
import { findBufferedRunRedirectInfo } from "~/v3/mollifier/syntheticRedirectInfo.server";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { runParam } = ParamsSchema.parse(params);

  const run = await prisma.taskRun.findFirst({
    where: {
      friendlyId: runParam,
      project: {
        organization: {
          members: {
            some: {
              userId: user.id,
            },
          },
        },
      },
    },
    select: {
      spanId: true,
      runtimeEnvironment: {
        select: {
          slug: true,
        },
      },
      project: {
        select: {
          slug: true,
          organization: {
            select: {
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!run) {
    // Fall back to the mollifier buffer. Without this a customer clicking
    // the run link returned by the trigger API gets bounced to the home
    // page until the drainer materialises the PG row.
    const buffered = await findBufferedRunRedirectInfo({ runFriendlyId: runParam, userId: user.id });
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
          { friendlyId: runParam },
          searchParams
        )
      );
    }
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "Run either doesn't exist or you don't have permission to view it",
      {
        ephemeral: false,
      }
    );
  }

  // Preserve existing search params from the request, add span if not already set
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  if (!searchParams.has("span") && run.spanId) {
    searchParams.set("span", run.spanId);
  }

  const path = v3RunPath(
    { slug: run.project.organization.slug },
    { slug: run.project.slug },
    { slug: run.runtimeEnvironment.slug },
    { friendlyId: runParam },
    searchParams
  );

  return redirect(path);
}
