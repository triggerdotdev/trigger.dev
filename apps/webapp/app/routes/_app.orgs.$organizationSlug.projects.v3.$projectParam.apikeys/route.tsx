import { BookOpenIcon, LightBulbIcon, ShieldCheckIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { UpgradeCallout } from "~/components/primitives/UpgradeCallout";
import { prisma } from "~/db.server";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { createEnvironment } from "~/models/organization.server";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath, v3ApiKeysPath, v3BillingPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new ApiKeysPresenter();
    const { environments, hasStaging } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
      environments,
      hasStaging,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { environments, hasStaging } = useTypedLoaderData<typeof loader>();
  const { isManagedCloud } = useFeatures();
  const organization = useOrganization();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API keys" />
        <PageAccessories>
          <AdminDebugTooltip>
            <PropertyTable>
              {environments.map((environment) => (
                <Property label={environment.slug} key={environment.id}>
                  <div className="flex items-center gap-2">
                    <Paragraph variant="extra-small/bright/mono">{environment.id}</Paragraph>
                  </div>
                </Property>
              ))}
            </PropertyTable>
          </AdminDebugTooltip>

          <LinkButton
            variant={"minimal/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/v3/apikeys")}
          >
            API keys docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className={cn("h-full")}>
          <Header3 spacing>Secret keys</Header3>
          <Paragraph variant="small" spacing>
            Secret keys should be used on your server – they give full API access and allow you to{" "}
            <TextLink to={docsPath("v3/triggering")}>trigger tasks</TextLink> from your backend.
          </Paragraph>
          <Header3 spacing>Public API keys</Header3>
          <Paragraph variant="small" spacing>
            These keys have limited read-only access and should be used in your frontend.
          </Paragraph>
          <div className="mt-4 flex flex-col gap-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell>Secret key</TableHeaderCell>
                  <TableHeaderCell>Public API key</TableHeaderCell>
                  <TableHeaderCell>Keys generated</TableHeaderCell>
                  <TableHeaderCell>Latest version</TableHeaderCell>
                  <TableHeaderCell>Env vars</TableHeaderCell>
                  <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {environments.map((environment) => (
                  <TableRow key={environment.id}>
                    <TableCell>
                      <EnvironmentLabel environment={environment} />
                    </TableCell>
                    <TableCell>
                      <ClipboardField
                        className="w-full max-w-none"
                        secure={`tr_${environment.apiKey.split("_")[1]}_••••••••`}
                        value={environment.apiKey}
                        variant={"tertiary/small"}
                      />
                    </TableCell>
                    <TableCell>
                      <ClipboardField
                        className="w-full max-w-none"
                        value={environment.pkApiKey}
                        variant={"tertiary/small"}
                      />
                    </TableCell>
                    <TableCell>
                      <DateTime date={environment.updatedAt} />
                    </TableCell>
                    <TableCell>{environment.latestVersion ?? "–"}</TableCell>
                    <TableCell>{environment.environmentVariableCount}</TableCell>
                    <TableCellMenu isSticky>
                      <RegenerateApiKeyModal
                        id={environment.id}
                        title={environmentTitle(environment)}
                      />
                    </TableCellMenu>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {!hasStaging && (
              <UpgradeCallout title="Add a Staging environment">
                Upgrade your plan to add a Staging environment.
              </UpgradeCallout>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
