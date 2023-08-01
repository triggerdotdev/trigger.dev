import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/solid";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { LabelValueStack } from "~/components/primitives/LabelValueStack";
import { NamedIcon } from "~/components/primitives/NamedIcon";
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
import { ProjectParamSchema, externalTriggerPath, trimTrailingSlash } from "~/utils/pathBuilder";

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
  breadcrumb: (match) => (
    <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="External Triggers" />
  ),
  expandSidebar: true,
};

export default function Integrations() {
  const { triggers } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <>
      <Paragraph variant="small" spacing>
        External Triggers get registered with external APIs, for example a webhook.
      </Paragraph>
      <Table containerClassName="mt-4">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Integration</TableHeaderCell>
            <TableHeaderCell>Dynamic</TableHeaderCell>
            <TableHeaderCell>Properties</TableHeaderCell>
            <TableHeaderCell>Environment</TableHeaderCell>
            <TableHeaderCell>Active</TableHeaderCell>
            <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {triggers.length > 0 ? (
            triggers.map((t) => {
              const path = externalTriggerPath(organization, project, t);
              return (
                <TableRow key={t.id} className={cn(!t.active && "bg-rose-500/30")}>
                  <TableCell to={path}>
                    <div className="flex items-center gap-1">
                      <NamedIcon
                        name={t.integration.definition.icon ?? t.integration.definitionId}
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
                    {t.dynamicTrigger ? (
                      <span className="flex items-center gap-0.5">
                        <NamedIcon name="dynamic" className="h-4 w-4" />
                        {t.dynamicTrigger.slug}
                      </span>
                    ) : (
                      <span className="text-dimmed">–</span>
                    )}
                  </TableCell>
                  <TableCell to={path}>
                    {t.params && (
                      <SimpleTooltip
                        button={
                          <div className="flex max-w-[200px] items-start justify-start gap-5 truncate">
                            {Object.entries(t.params).map(([label, value], index) => (
                              <LabelValueStack
                                key={index}
                                label={label}
                                value={value}
                                className="last:truncate"
                              />
                            ))}
                          </div>
                        }
                        content={
                          <div className="flex flex-col gap-2">
                            {Object.entries(t.params).map(([label, value], index) => (
                              <LabelValueStack key={index} label={label} value={value} />
                            ))}
                          </div>
                        }
                      />
                    )}
                  </TableCell>
                  <TableCell to={path}>
                    <span className="flex">
                      <EnvironmentLabel environment={t.environment} />
                    </span>
                  </TableCell>
                  <TableCell to={path}>
                    {t.active ? (
                      <CheckCircleIcon className="h-6 w-6 text-green-500" />
                    ) : (
                      <XCircleIcon className="h-6 w-6 text-rose-500" />
                    )}
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
