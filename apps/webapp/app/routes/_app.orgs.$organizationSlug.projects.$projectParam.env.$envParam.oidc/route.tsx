import { useState } from "react";
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
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  getExternalOidcController,
  isExternalOidcEnabled,
} from "~/services/oidc/externalOidc.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { AWS_S3_READ_PERMISSIONS, awsOidcTaskExample, awsOidcTrustPolicy } from "~/utils/oidcSetup";
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
          projectId: project.id,
          projectRef: project.externalRef,
          orgFeatureFlags,
        }),
      },
    });
  }
);

const AWS_ACCOUNT_ID_PLACEHOLDER = "YOUR_AWS_ACCOUNT_ID";
const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;

export default function OidcSetupPage() {
  const { state, setup } = useTypedLoaderData<typeof loader>();
  const [accountId, setAccountId] = useState("");
  const validAccountId = AWS_ACCOUNT_ID_PATTERN.test(accountId);
  const exampleAccountId = validAccountId ? accountId : AWS_ACCOUNT_ID_PLACEHOLDER;

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
        <MainHorizontallyCenteredContainer className="mb-12 max-w-3xl space-y-6">
          <Paragraph>Access AWS from deployed tasks using short-lived credentials.</Paragraph>

          {state === "development" ? (
            <Callout variant="info">
              OIDC requires a deployed environment. Select Production, Staging or Preview. For local
              development, use your own AWS credentials.
            </Callout>
          ) : setup ? (
            <>
              <section className="space-y-3">
                <Header2>1. Add an IAM identity provider</Header2>
                <Paragraph>
                  In AWS IAM, choose Identity providers → Add provider → OpenID Connect. Use these
                  values, or reuse an existing provider.
                </Paragraph>
                <div className="space-y-1">
                  <Header2 className="text-sm">Issuer URL</Header2>
                  <ClipboardField value={setup.issuer} variant="secondary/medium" />
                </div>
                <div className="space-y-1">
                  <Header2 className="text-sm">Audience</Header2>
                  <ClipboardField value={setup.audience} variant="secondary/medium" />
                </div>
                <Paragraph>Or create the provider with the AWS CLI:</Paragraph>
                <CodeBlock
                  code={`aws iam create-open-id-connect-provider --url "${setup.issuer}" --client-id-list "${setup.audience}"`}
                  language="bash"
                  showChrome
                  showLineNumbers={false}
                />
              </section>

              <section className="space-y-3">
                <Header2>2. Create an IAM role</Header2>
                <Paragraph>
                  Enter your AWS account ID, then create a role with this trust policy.
                </Paragraph>
                <div className="space-y-1">
                  <Header2 className="text-sm">Subject</Header2>
                  <ClipboardField value={setup.subject} variant="secondary/medium" />
                </div>
                <div className="max-w-sm space-y-2">
                  <Label htmlFor="aws-account-id">AWS account ID</Label>
                  <Input
                    id="aws-account-id"
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value.trim())}
                    placeholder="12-digit AWS account ID"
                    inputMode="numeric"
                    maxLength={12}
                    pattern="[0-9]{12}"
                    aria-describedby="aws-account-id-hint"
                    aria-invalid={accountId.length > 0 && !validAccountId}
                  />
                  <Paragraph id="aws-account-id-hint" variant="small">
                    Updates the examples below.
                  </Paragraph>
                </div>
                <CodeBlock
                  code={awsOidcTrustPolicy(setup, exampleAccountId)}
                  language="json"
                  showChrome
                  showLineNumbers={false}
                  showCopyButton
                />
                <Paragraph>
                  To share a role across Preview branches, see{" "}
                  <TextLink href={`${docsPath("oidc")}#set-up-aws`} target="_blank">
                    Preview trust policies
                  </TextLink>
                  .
                </Paragraph>
              </section>

              <section className="space-y-3">
                <Header2>3. Attach permissions to the role</Header2>
                <Paragraph>
                  Attach permissions for the AWS services your task needs. This example allows
                  reading an S3 prefix.
                </Paragraph>
                <CodeBlock
                  code={AWS_S3_READ_PERMISSIONS}
                  language="json"
                  showChrome
                  showLineNumbers={false}
                />
              </section>

              <section className="space-y-3">
                <Header2>4. Use the SDK</Header2>
                <Paragraph>
                  Install the SDK and AWS clients, then use the credential provider in your task.
                </Paragraph>
                <CodeBlock
                  code="npm install @trigger.dev/sdk@latest @aws-sdk/client-sts @aws-sdk/client-s3"
                  language="bash"
                  showChrome
                  showLineNumbers={false}
                />
                <CodeBlock
                  code={awsOidcTaskExample(exampleAccountId)}
                  language="typescript"
                  showChrome
                  showLineNumbers={false}
                />
              </section>

              <section className="space-y-3">
                <Header2>5. Redeploy</Header2>
                <Paragraph>
                  Use SDK and CLI 4.8.3 or later, including in CI. Redeploy and start a new run.
                </Paragraph>
              </section>
            </>
          ) : null}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
