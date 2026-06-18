import { BookOpenIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import {
  EnvironmentCombo,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { PermissionDenied } from "~/components/PermissionDenied";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import * as Property from "~/components/primitives/PropertyTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `API keys | Trigger.dev`,
    },
  ];
};

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    // No hard authorization: anyone with project access can open the page.
    // Reading the secret key is gated per environment tier below — a role
    // that can't read this tier's keys gets the info panel, not the key.
  },
  async ({ params, user, ability }) => {
    const { projectParam, envParam } = params;

    try {
      const presenter = new ApiKeysPresenter();
      const { environment, hasVercelIntegration } = await presenter.call({
        userId: user.id,
        projectSlug: projectParam,
        environmentSlug: envParam,
      });

      const canReadApiKeys =
        !environment || ability.can("read", { type: "apiKeys", envType: environment.type });

      return typedjson({
        // Never serialize the secret key to the client when the role can't
        // read it for this environment tier.
        environment: environment && !canReadApiKeys ? { ...environment, apiKey: "" } : environment,
        hasVercelIntegration,
        canReadApiKeys,
      });
    } catch (error) {
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

export default function Page() {
  const { environment, hasVercelIntegration, canReadApiKeys } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  let envBlock = `TRIGGER_SECRET_KEY="${environment.apiKey}"`;
  if (environment.branchName) {
    envBlock += `\nTRIGGER_PREVIEW_BRANCH="${environment.branchName}"`;
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API keys" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item key={environment.id}>
                <Property.Label>{environment.slug}</Property.Label>
                <Property.Value>{environment.id}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>

          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/v3/apikeys")}
          >
            API keys docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <MainHorizontallyCenteredContainer>
          <div className="mb-3 border-b border-grid-dimmed pb-1">
            <Header2
              className={cn(
                "inline-flex items-center gap-1 font-normal",
                environmentTextClassName(environment)
              )}
            >
              <EnvironmentCombo
                environment={environment}
                className="text-base"
                iconClassName="size-5"
              />
              API keys
            </Header2>
          </div>
          {canReadApiKeys ? (
            <div className="flex flex-col gap-6">
              <InputGroup fullWidth>
                <div className="flex w-full items-center justify-between">
                  <Label>Secret key</Label>
                  <RegenerateApiKeyModal
                    id={environment.parentEnvironment?.id ?? environment.id}
                    title={environmentFullTitle(environment)}
                    hasVercelIntegration={hasVercelIntegration}
                    isDevelopment={environment.type === "DEVELOPMENT"}
                  />
                </div>
                <ClipboardField
                  className="w-full max-w-none"
                  secure={`tr_${environment.apiKey.split("_")[1]}_••••••••`}
                  value={environment.apiKey}
                  variant={"secondary/small"}
                />
                <Hint>
                  Set this as your <InlineCode variant="extra-small">TRIGGER_SECRET_KEY</InlineCode>{" "}
                  env var in your backend.
                </Hint>
              </InputGroup>
              {environment.branchName && (
                <InputGroup fullWidth>
                  <Label>Branch name</Label>
                  <ClipboardField
                    className="w-full max-w-none"
                    value={environment.branchName}
                    variant={"secondary/small"}
                  />
                  <Hint>
                    Set this as your{" "}
                    <InlineCode variant="extra-small">TRIGGER_PREVIEW_BRANCH</InlineCode> env var in
                    your backend.
                  </Hint>
                </InputGroup>
              )}
              {environment.type === "DEVELOPMENT" && (
                <Callout variant="info">
                  Every team member gets their own dev Secret key. Make sure you're using the one
                  above otherwise you will trigger runs on your team member's machine.
                </Callout>
              )}

              <Accordion type="single" collapsible>
                <AccordionItem value="item-1">
                  <AccordionTrigger>How to set these environment variables</AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-col gap-2">
                      <div>
                        You need to set these environment variables in your backend. This allows the
                        SDK to authenticate with Trigger.dev.
                      </div>
                      <CodeBlock
                        language="javascript"
                        code={envBlock}
                        showOpenInModal={false}
                        showLineNumbers={false}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          ) : (
            <PermissionDenied
              message={`With your current role, you can't view the API keys for ${environmentFullTitle(
                environment
              )}.`}
            />
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
