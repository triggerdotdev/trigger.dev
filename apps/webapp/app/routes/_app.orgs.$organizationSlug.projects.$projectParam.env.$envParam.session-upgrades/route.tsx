import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { SessionUpgradesPage } from "~/components/deployments/SessionUpgradesPage";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getSkewProtectionPage } from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import { rbac } from "~/services/rbac.server";
import { canWriteDeployments } from "~/services/canWriteDeployments.server";
import { requireUserId } from "~/services/session.server";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { EnvironmentParamSchema, v3DeploymentsPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Session upgrades");

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });
  // Thresholds don't apply in development: an environment switch lands on Deployments instead.
  if (environment.type === "DEVELOPMENT") {
    throw redirect(
      v3DeploymentsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam })
    );
  }

  // Project-scoped, as the set and clear action authenticates: a project role counts for both.
  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  if (!auth.ok || !auth.ability.can("read", { type: "deployments" })) {
    throwPermissionDenied();
  }

  const page = await getSkewProtectionPage($replica, { environmentId: environment.id, userId });
  return typedjson({
    ...page,
    environmentId: environment.id,
    canWriteDeployments: canWriteDeployments(auth),
  });
};

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  return <SessionUpgradesPage data={data} />;
}
