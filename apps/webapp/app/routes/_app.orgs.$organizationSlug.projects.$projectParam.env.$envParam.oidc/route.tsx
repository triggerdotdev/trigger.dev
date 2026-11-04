import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CodeBlock } from "~/components/code/CodeBlock";
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
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { cachedFlag } from "~/v3/featureFlags.server";

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

    const integrationGuidesPublished = await cachedFlag({
      key: FEATURE_FLAG.oidcIntegrationGuidesPublished,
      defaultValue: false,
    });

    if (environment.type === "DEVELOPMENT") {
      return typedjson({ state: "development" as const, setup: null, integrationGuidesPublished });
    }

    return typedjson({
      state: "available" as const,
      integrationGuidesPublished,
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
  const { state, setup, integrationGuidesPublished } = useTypedLoaderData<typeof loader>();
  const awsConditionPrefix = setup?.issuer.replace(/^https:\/\//, "");

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
                      <>
                        <div className="space-y-1">
                          <Paragraph variant="small/bright">AWS audience</Paragraph>
                          <ClipboardField value={setup.audience} variant="secondary/medium" />
                        </div>
                        {!integrationGuidesPublished && (
                          <>
                            <Header3>AWS setup notes</Header3>
                            <Paragraph variant="small">
                              The issuer URL is organization-specific. Use the full Issuer URL
                              above, including the organization slug, when creating your IAM OIDC
                              provider.
                            </Paragraph>
                            <CodeBlock
                              code={`aws iam create-open-id-connect-provider \\
  --url "${setup.issuer}" \\
  --client-id-list "${setup.audience}"`}
                              language="bash"
                              showLineNumbers={false}
                            />
                            <Paragraph variant="small">
                              In your IAM role's trust policy, prefix both the aud and sub condition
                              keys with the full issuer, including the organization slug, but
                              without https://. The audience (aud) must match the audience requested
                              by your task; for AWS, use {setup.audience}. The subject (sub) must
                              match the Subject above to restrict access to this project and
                              environment.
                            </Paragraph>
                            <CodeBlock
                              code={JSON.stringify(
                                {
                                  Condition: {
                                    StringEquals: {
                                      [`${awsConditionPrefix}:aud`]: setup.audience,
                                      [`${awsConditionPrefix}:sub`]: setup.subject,
                                    },
                                  },
                                },
                                null,
                                2
                              )}
                              language="json"
                              showLineNumbers={false}
                            />
                          </>
                        )}
                      </>
                    )}
                    {integrationGuidesPublished && (
                      <LinkButton
                        to={docsPath("oidc/aws")}
                        variant="secondary/small"
                        target="_blank"
                      >
                        AWS setup guide
                      </LinkButton>
                    )}
                  </div>
                  {integrationGuidesPublished && (
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
                  )}
                  <div className="space-y-3 rounded-md border border-grid-dimmed bg-background-bright p-4">
                    <div className="space-y-1">
                      <Header3>Custom OIDC</Header3>
                      <Paragraph variant="small">
                        Connect a service that accepts OIDC tokens. Request a token with the
                        audience your service expects.
                      </Paragraph>
                    </div>
                    {integrationGuidesPublished ? (
                      <LinkButton
                        to={docsPath("oidc/custom")}
                        variant="secondary/small"
                        target="_blank"
                      >
                        Custom OIDC guide
                      </LinkButton>
                    ) : (
                      <>
                        <Paragraph variant="small">
                          Your service must support external OIDC workload identities, not just OIDC
                          user login. Register the organization-specific Issuer URL above, configure
                          the expected audience, and restrict access to the exact Subject for this
                          environment. Grant only the permissions your task needs. The service must
                          verify the token's signature, issuer, audience, and expiry, and enforce
                          the subject restriction.
                        </Paragraph>
                        <Paragraph variant="small">
                          Request a token inside a deployed task using the same audience you
                          configured in the receiving service:
                        </Paragraph>
                        <CodeBlock
                          code={`import { auth, task } from "@trigger.dev/sdk";

export const federatedTask = task({
  id: "federated-task",
  run: async () => {
    const { token } = await auth.getOIDCToken({
      audience: "https://service.example.com",
    });

    // Use the service's documented token exchange or authentication flow.
    // Never log or return the token.
  },
});`}
                          language="typescript"
                          showLineNumbers={false}
                        />
                        <Paragraph variant="small">
                          Most services exchange the token for temporary credentials. Send it
                          directly as a bearer token only if the service explicitly supports that
                          flow. Keep tokens and credentials within the executing run and refresh
                          before expiry. After upgrading the SDK and CLI, redeploy and start a new
                          run. For local Development runs, use the service's own development
                          credentials instead.
                        </Paragraph>
                      </>
                    )}
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
