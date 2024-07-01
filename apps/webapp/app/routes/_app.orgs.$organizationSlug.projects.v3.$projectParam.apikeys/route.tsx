import { BookOpenIcon } from "@heroicons/react/20/solid";
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
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
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
        <div className={cn("h-full")}>
          <Header3 spacing>Secret keys</Header3>
          <Paragraph variant="small" spacing>
            Secret keys should be used on your server – they give full API access and allow you to{" "}
            <TextLink to={docsPath("v3/triggering")}>trigger tasks</TextLink> from your backend.
          </Paragraph>
          <div className="mt-4 flex flex-col gap-6">
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
