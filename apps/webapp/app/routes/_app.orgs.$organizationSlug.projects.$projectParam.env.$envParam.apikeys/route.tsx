import { ArrowUpCircleIcon, BookOpenIcon, InformationCircleIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
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
import { docsPath, ProjectParamSchema, v3BillingPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `API keys | Trigger.dev`,
    },
  ];
};

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
        <div className="flex flex-col">
          <Table containerClassName="border-t-0">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Environment</TableHeaderCell>
                <TableHeaderCell>Secret key</TableHeaderCell>
                <TableHeaderCell>Key generated</TableHeaderCell>
                <TableHeaderCell>Latest version</TableHeaderCell>
                <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((environment) => (
                <TableRow key={environment.id}>
                  <TableCell>
                    <EnvironmentCombo environment={environment} />
                  </TableCell>
                  <TableCell>
                    <ClipboardField
                      className="w-full max-w-none"
                      secure={`tr_${environment.apiKey.split("_")[1]}_••••••••`}
                      value={environment.apiKey}
                      variant={"secondary/small"}
                    />
                  </TableCell>
                  <TableCell>
                    <DateTime date={environment.updatedAt} />
                  </TableCell>
                  <TableCell>{environment.latestVersion ?? "–"}</TableCell>
                  <TableCellMenu
                    isSticky
                    popoverContent={
                      <RegenerateApiKeyModal
                        id={environment.id}
                        title={environmentFullTitle(environment)}
                      />
                    }
                  ></TableCellMenu>
                </TableRow>
              ))}
              {!hasStaging && (
                <>
                  <TableRow>
                    <TableCell>
                      <EnvironmentCombo environment={{ type: "STAGING" }} />
                    </TableCell>
                    <TableCell>
                      <LinkButton
                        to={v3BillingPath(
                          organization,
                          "Upgrade to unlock a Staging environment for your projects."
                        )}
                        variant="secondary/small"
                        LeadingIcon={ArrowUpCircleIcon}
                        leadingIconClassName="text-indigo-500"
                      >
                        Upgrade to get staging environment
                      </LinkButton>
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>
                      <EnvironmentCombo environment={{ type: "PREVIEW" }} />
                    </TableCell>
                    <TableCell>
                      <LinkButton
                        to={v3BillingPath(
                          organization,
                          "Upgrade to unlock Preview branches for your projects."
                        )}
                        variant="secondary/small"
                        LeadingIcon={ArrowUpCircleIcon}
                        leadingIconClassName="text-indigo-500"
                      >
                        Upgrade to get preview branches
                      </LinkButton>
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>

          <div className="flex flex-wrap justify-between">
            <InfoPanel icon={InformationCircleIcon} variant="minimal" panelClassName="max-w-fit">
              <Paragraph variant="small">
                Set your <TextLink to={docsPath("apikeys")}>Secret keys</TextLink> in your backend
                by adding <InlineCode>TRIGGER_SECRET_KEY</InlineCode> env var in order to{" "}
                <TextLink to={docsPath("v3/triggering")}>trigger tasks</TextLink>.
              </Paragraph>
            </InfoPanel>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
