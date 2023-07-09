import {
  CheckCircleIcon,
  ChevronRightIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { useCallback, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { LogoIcon } from "~/components/LogoIcon";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { HowToConnectAnIntegration } from "~/components/helpContent/HelpContentText";
import { ConnectToIntegrationSheet } from "~/components/integrations/ConnectToIntegrationSheet";
import { IntegrationWithMissingFieldSheet } from "~/components/integrations/IntegrationWithMissingFieldSheet";
import { NoIntegrationSheet } from "~/components/integrations/NoIntegrationSheet";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon, NamedIconInBox } from "~/components/primitives/NamedIcon";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTextFilter } from "~/hooks/useTextFilter";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import {
  Client,
  IntegrationOrApi,
  IntegrationsPresenter,
} from "~/presenters/IntegrationsPresenter.server";
import { TriggersPresenter } from "~/presenters/TriggersPresenter.server";
import { requireUser } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  ProjectParamSchema,
  docsCreateIntegration,
  integrationClientPath,
  triggerSourcePath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const presenter = new TriggersPresenter();
  const data = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
  });

  return typedjson(data);
};

export const handle: Handle = {
  breadcrumb: {
    slug: "triggers",
  },
};

export default function Integrations() {
  const { triggers } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  console.log(triggers);

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Triggers" />
        </PageTitleRow>
        <PageDescription>Triggers causes Jobs to run.</PageDescription>
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <div>
            <Header2 spacing>External Triggers</Header2>
            <Paragraph variant="small" spacing>
              Webhooks are connected as external Triggers
            </Paragraph>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Integration</TableHeaderCell>
                  <TableHeaderCell>Properties</TableHeaderCell>
                  <TableHeaderCell>Active</TableHeaderCell>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {triggers.map((t) => {
                  const path = triggerSourcePath(organization, project, t);
                  return (
                    <TableRow key={t.id}>
                      <TableCell to={path}>
                        <span className="flex items-center gap-1">
                          <NamedIcon
                            name={t.integration.definitionId}
                            className="h-6 w-6"
                          />
                          {t.integration.title}
                        </span>
                      </TableCell>
                      <TableCell to={path}>
                        {t.params && (
                          <SimpleTooltip
                            button={
                              <div className="flex max-w-[200px] items-start justify-start gap-5 truncate">
                                {Object.entries(t.params).map(
                                  ([label, value], index) => (
                                    <LabelValueStack
                                      key={index}
                                      label={label}
                                      value={value}
                                      className="last:truncate"
                                    />
                                  )
                                )}
                              </div>
                            }
                            content={
                              <div className="flex flex-col gap-2">
                                {Object.entries(t.params).map(
                                  ([label, value], index) => (
                                    <LabelValueStack
                                      key={index}
                                      label={label}
                                      value={value}
                                    />
                                  )
                                )}
                              </div>
                            }
                          />
                        )}
                      </TableCell>
                      <TableCell to={path}>
                        {t.active ? (
                          <CheckCircleIcon className="h-6 w-6 text-green-500" />
                        ) : (
                          <XCircleIcon className="h-6 w-6 text-rose-500" />
                        )}
                      </TableCell>
                      <TableCell to={path}>
                        <span className="flex">
                          <EnvironmentLabel environment={t.environment} />
                        </span>
                      </TableCell>
                      <TableCellChevron to={path} />
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
