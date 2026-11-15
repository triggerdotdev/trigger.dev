import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  getExternalOidcController,
  isExternalOidcEnabled,
} from "~/services/oidc/externalOidc.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { $replica } from "~/db.server";
import { findOidcReplaceableValues } from "~/presenters/v3/environmentVariablesAttention.server";
import { groupOidcReplaceable } from "~/v3/environmentVariables/oidcReplaceable";
import { OidcProvidersPage } from "./OidcProvidersPage";

export const meta = pageMeta("OpenID Connect (OIDC)");

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ params, user }) => {
    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) throw new Response("Project not found", { status: 404 });

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) throw new Response("Environment not found", { status: 404 });

    const controller = await getExternalOidcController();
    const orgFeatureFlags = environment.organization.featureFlags;
    if (!controller || !(await isExternalOidcEnabled(orgFeatureFlags))) {
      throw new Response("Not found", { status: 404 });
    }

    if (environment.type === "DEVELOPMENT") {
      return typedjson({ state: "development" as const, setup: null, replaceable: [] });
    }

    // Env vars a service below could replace, across the project's deployed environments.
    const replaceable = groupOidcReplaceable(
      await findOidcReplaceableValues($replica, { projectId: project.id })
    );

    return typedjson({
      state: "available" as const,
      replaceable,
      setup: {
        ...controller.getSetup({
          id: environment.id,
          slug: environment.slug,
          type: environment.type,
          organizationId: environment.organizationId,
          organizationSlug: environment.organization.slug,
          projectId: project.id,
          projectRef: project.externalRef,
          orgFeatureFlags,
        }),
      },
    });
  }
);

export default function OidcSetupPage() {
  const { state, setup, replaceable } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="OpenID Connect (OIDC)" />
        <PageAccessories>
          <LinkButton to={docsPath("oidc")} variant="secondary/small" target="_blank">
            OIDC documentation
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <OidcProvidersPage state={state} setup={setup} replaceable={replaceable} />
    </PageContainer>
  );
}
