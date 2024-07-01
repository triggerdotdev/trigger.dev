import { BookOpenIcon } from "@heroicons/react/20/solid";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentLabel, environmentTitle } from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
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
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, docsPath } from "~/utils/pathBuilder";

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
        <div className="mt-1 flex flex-col gap-4">
          <Table>
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

          <div className="flex items-start gap-3">
            <div className="flex max-w-sm flex-col items-start justify-between gap-3 rounded-md border border-grid-bright p-4">
              <div className="flex w-full items-center justify-between gap-2">
                <InformationCircleIcon className="size-6 text-text-dimmed" />
              </div>
              <div className="flex flex-col gap-1">
                <Header3 className="text-text-bright">Secret keys</Header3>
                <Paragraph variant={"small"} className="text-text-dimmed">
                  Secret keys should be used on your server. They give full API access and allow you
                  to <TextLink to={docsPath("v3/triggering")}>trigger tasks</TextLink> from your
                  backend.
                </Paragraph>
              </div>
            </div>

            {!hasStaging && (
              <UpgradeCallout title="Unlock a Staging environment">
                Upgrade your plan to add a Staging environment.
              </UpgradeCallout>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
