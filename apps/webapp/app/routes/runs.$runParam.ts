import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { rootPath, v3RunPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { runParam } = ParamsSchema.parse(params);

  const run = await runStore.findRun(
    {
      friendlyId: runParam,
    },
    {
      select: {
        spanId: true,
        projectId: true,
        runtimeEnvironmentId: true,
      },
    }
  );

  if (!run) {
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "Run either doesn't exist or you don't have permission to view it",
      {
        ephemeral: false,
      }
    );
  }

  const authorizedProject = await $replica.project.findFirst({
    where: { id: run.projectId, organization: { members: { some: { userId: user.id } } } },
    select: { id: true },
  });

  if (!authorizedProject) {
    return redirectWithErrorMessage(
      rootPath(),
      request,
      "Run either doesn't exist or you don't have permission to view it",
      {
        ephemeral: false,
      }
    );
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment) {
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
    { slug: environment.organization.slug },
    { slug: environment.project.slug },
    { slug: environment.slug },
    { friendlyId: runParam },
    searchParams
  );

  return redirect(path);
}
