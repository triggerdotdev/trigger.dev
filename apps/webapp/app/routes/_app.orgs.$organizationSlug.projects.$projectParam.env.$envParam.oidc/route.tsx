import { typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
      return typedjson({ state: "development" as const, setup: null });
    }

    return typedjson({
      state: "available" as const,
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
  const { state, setup } = useTypedLoaderData<typeof loader>();

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
      <PageBody>
        <MainHorizontallyCenteredContainer className="mb-12 max-w-3xl space-y-8">
          <Paragraph>
            Use workload identity to access AWS and other services from your tasks with short-lived
            tokens, without storing long-lived credentials.
          </Paragraph>

          {state === "development" ? (
            <Callout variant="info">
              OIDC tokens are not available for local development. Choose a deployed environment to
              see its OIDC details.
            </Callout>
          ) : (
            <>
              <Callout variant="info">Use Trigger SDK and CLI version 4.8.3 or later.</Callout>

              {setup && (
                <section className="space-y-3">
                  <div className="space-y-1">
                    <Header2>Token details</Header2>
                    <Paragraph variant="small">
                      Use these values to configure your service to trust this environment.
                    </Paragraph>
                  </div>
                  <div className="space-y-4 rounded-md border border-grid-dimmed bg-background-bright p-4">
                    <div className="space-y-1">
                      <Header3>Issuer URL</Header3>
                      <ClipboardField value={setup.issuer} variant="secondary/small" />
                    </div>
                    <div className="space-y-1">
                      <Header3>Subject</Header3>
                      <ClipboardField value={setup.subject} variant="secondary/small" />
                    </div>
                  </div>
                </section>
              )}

              <section className="space-y-3">
                <Header2>Connect a service</Header2>
                <div className="space-y-4">
                  <div className="space-y-3 rounded-md border border-grid-dimmed bg-background-bright p-4">
                    <div className="space-y-1">
                      <Header3>Amazon Web Services</Header3>
                      <Paragraph variant="small">
                        Assume an IAM role from your tasks with the AWS credential provider.
                      </Paragraph>
                    </div>
                    {setup && (
                      <div className="space-y-1">
                        <Paragraph variant="small/bright">AWS audience</Paragraph>
                        <ClipboardField value={setup.audience} variant="secondary/medium" />
                      </div>
                    )}
                    <LinkButton to={docsPath("oidc/aws")} variant="secondary/small" target="_blank">
                      AWS setup guide
                    </LinkButton>
                  </div>
                  <div className="space-y-3 rounded-md border border-grid-dimmed bg-background-bright p-4">
                    <div className="space-y-1">
                      <Header3>Infisical</Header3>
                      <Paragraph variant="small">
                        Read secrets from Infisical using your task's workload identity.
                      </Paragraph>
                    </div>
                    <LinkButton
                      to={docsPath("oidc/infisical")}
                      variant="secondary/small"
                      target="_blank"
                    >
                      Infisical setup guide
                    </LinkButton>
                  </div>
                  <div className="space-y-3 rounded-md border border-grid-dimmed bg-background-bright p-4">
                    <div className="space-y-1">
                      <Header3>Custom OIDC</Header3>
                      <Paragraph variant="small">
                        Connect a service that accepts OIDC tokens. Request a token with the
                        audience your service expects.
                      </Paragraph>
                    </div>
                    <LinkButton
                      to={docsPath("oidc/custom")}
                      variant="secondary/small"
                      target="_blank"
                    >
                      Custom OIDC guide
                    </LinkButton>
                  </div>
                </div>
              </section>
            </>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
