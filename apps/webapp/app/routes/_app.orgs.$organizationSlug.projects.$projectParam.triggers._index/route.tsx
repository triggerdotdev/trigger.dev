import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/solid";
import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageDescription,
  PageHeader,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { TriggersPresenter } from "~/presenters/TriggersPresenter.server";
import { requireUser } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  ProjectParamSchema,
  triggerSourcePath,
  projectTriggersPath,
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
    link: {
      title: "External",
    },
  },
};

export default function Integrations() {
  const { triggers } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <>
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
          {triggers.length > 0 ? (
            triggers.map((t) => {
              const path = triggerSourcePath(organization, project, t);
              return (
                <TableRow
                  key={t.id}
                  className={cn(!t.active && "bg-rose-500/30")}
                >
                  <TableCell to={path}>
                    <div className="flex items-center gap-1">
                      <NamedIcon
                        name={t.integration.definitionId}
                        className="h-8 w-8"
                      />
                      <LabelValueStack
                        label={t.integration.title}
                        value={t.integration.slug}
                        variant="primary"
                      />
                    </div>
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
            })
          ) : (
            <TableBlankRow colSpan={5}>
              <Paragraph>No External triggers</Paragraph>
            </TableBlankRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}
