import { BookOpenIcon, InformationCircleIcon, LockOpenIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, docsPath, v3BillingPath } from "~/utils/pathBuilder";

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
  const organization = useOrganization();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API keys" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {environments.map((environment) => (
                <Property.Item key={environment.id}>
                  <Property.Label>{environment.slug}</Property.Label>
                  <Property.Value>{environment.id}</Property.Value>
                </Property.Item>
              ))}
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
      <PageBody scrollable={false}>
        <div className="flex flex-col gap-4">
          <Table containerClassName="border-t-0">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Environment</TableHeaderCell>
                <TableHeaderCell>Secret key</TableHeaderCell>
                <TableHeaderCell>Key generated</TableHeaderCell>
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

          <div className="flex gap-3">
            <InfoPanel icon={InformationCircleIcon} panelClassName="max-w-full ml-3">
              <Paragraph variant="small">
                Secret keys should be used on your server. They give full API access and allow you
                to <TextLink to={docsPath("v3/triggering")}>trigger tasks</TextLink> from your
                backend.
              </Paragraph>
            </InfoPanel>

            {!hasStaging && (
              <InfoPanel
                icon={LockOpenIcon}
                variant="upgrade"
                title="Unlock a Staging environment"
                to={v3BillingPath(organization)}
                buttonLabel="Upgrade"
                iconClassName="text-indigo-500"
              >
                Upgrade your plan to add a Staging environment.
              </InfoPanel>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
