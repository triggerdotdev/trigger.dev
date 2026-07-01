import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { impersonate, rootPath, v3RunPath, v3RunSpanPath } from "~/utils/pathBuilder";
import { findBufferedRunRedirectInfo } from "~/v3/mollifier/syntheticRedirectInfo.server";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { runParam } = ParamsSchema.parse(params);

  const isAdmin = user.admin || user.isImpersonating;

  if (!isAdmin) {
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "You're not an admin and cannot impersonate",
      {
        ephemeral: false,
      }
    );
  }

  const run = await runStore.findRun(
    {
      friendlyId: runParam,
    },
    {
      select: {
        spanId: true,
        runtimeEnvironmentId: true,
      },
    },
    prisma
  );

  if (!run) {
    // Admin impersonation route — bypass org membership so admins can
    // open any buffered run by friendlyId, mirroring the existing PG
    // behaviour above (no membership filter on the find).
    const buffered = await findBufferedRunRedirectInfo({
      runFriendlyId: runParam,
      userId: user.id,
      skipOrgMembershipCheck: true,
    });
    if (buffered) {
      // Preselect the root span so the run-detail trace tree opens with
      // the buffered run's span highlighted, matching the sibling
      // redirect routes (runs.$runParam.ts, projects.v3.$projectRef…).
      const path = buffered.spanId
        ? v3RunSpanPath(
            { slug: buffered.organizationSlug },
            { slug: buffered.projectSlug },
            { slug: buffered.environmentSlug },
            { friendlyId: runParam },
            { spanId: buffered.spanId }
          )
        : v3RunPath(
            { slug: buffered.organizationSlug },
            { slug: buffered.projectSlug },
            { slug: buffered.environmentSlug },
            { friendlyId: runParam }
          );
      return redirect(impersonate(path));
    }
    return redirectWithErrorMessage(rootPath(), request, "Run doesn't exist", {
      ephemeral: false,
    });
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment) {
    return redirectWithErrorMessage(rootPath(), request, "Run doesn't exist", {
      ephemeral: false,
    });
  }

  const path = v3RunSpanPath(
    { slug: environment.organization.slug },
    { slug: environment.project.slug },
    { slug: environment.slug },
    { friendlyId: runParam },
    { spanId: run.spanId }
  );

  return redirect(impersonate(path));
}
