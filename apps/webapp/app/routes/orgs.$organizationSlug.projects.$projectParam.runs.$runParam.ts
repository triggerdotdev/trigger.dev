import { redirect } from "@remix-run/router";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, v3RunPath } from "~/utils/pathBuilder";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

const ParamSchema = ProjectParamSchema.extend({
  runParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, runParam } = ParamSchema.parse(params);

  const run = await runStore.findRun(
    {
      friendlyId: runParam,
    },
    {
      select: {
        projectId: true,
        runtimeEnvironmentId: true,
      },
    }
  );

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  const authorizedProject = await $replica.project.findFirst({
    where: { id: run.projectId, organization: { members: { some: { userId } } } },
    select: { id: true },
  });

  if (!authorizedProject) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  if (
    environment.project.slug !== projectParam ||
    environment.organization.slug !== organizationSlug
  ) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(
    v3RunPath(
      {
        slug: organizationSlug,
      },
      { slug: projectParam },
      { slug: environment.slug },
      { friendlyId: runParam }
    )
  );
};
