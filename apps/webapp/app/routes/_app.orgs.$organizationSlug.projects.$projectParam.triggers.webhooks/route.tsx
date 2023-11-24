import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/solid";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
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
import { WebhookTriggersPresenter } from "~/presenters/WebhookTriggersPresenter.server";
import { requireUser } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { ProjectParamSchema, trimTrailingSlash, webhookTriggerPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const presenter = new WebhookTriggersPresenter();
  const data = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
  });

  return typedjson(data);
};

export const handle: Handle = {
  breadcrumb: (match) => (
    <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Webhook Triggers" />
  ),
};

export default function Integrations() {
  const { webhooks } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <>
      <Paragraph variant="small" spacing>
        A Webhook Trigger runs a Job when it receives a matching payload at a registered HTTP Endpoint.
      </Paragraph>

      <Table containerClassName="mt-4">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Key</TableHeaderCell>
            <TableHeaderCell>Integration</TableHeaderCell>
            <TableHeaderCell>Properties</TableHeaderCell>
            <TableHeaderCell>Environment</TableHeaderCell>
            <TableHeaderCell>Active</TableHeaderCell>
            <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {webhooks.length > 0 ? (
            webhooks.map((w) => {
              const path = webhookTriggerPath(organization, project, w);
              return (
                <TableRow key={w.id} className={cn(!w.active && "bg-rose-500/30")}>
                <TableCell to={path}>{w.key}</TableCell>
                  <TableCell to={path}>
                    <div className="flex items-center gap-1">
                      <NamedIcon
                        name={w.integration.definition.icon ?? w.integration.definitionId}
                        className="h-8 w-8"
                      />
                      <LabelValueStack
                        label={w.integration.title}
                        value={w.integration.slug}
                        variant="primary"
                      />
                    </div>
                  </TableCell>
                  <TableCell to={path}>
                    {w.params && (
                      <SimpleTooltip
                        button={
                          <div className="flex max-w-[200px] items-start justify-start gap-5 truncate">
                            {Object.entries(w.params).map(([label, value], index) => (
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
                            {Object.entries(w.params).map(([label, value], index) => (
                              <LabelValueStack key={index} label={label} value={value} />
                            ))}
                          </div>
                        }
                      />
                    )}
                  </TableCell>
                  <TableCell to={path}>
                    <div className="flex items-center justify-end gap-1">
                      {w.webhookEnvironments.map((env) => (
                        <EnvironmentLabel
                          key={env.id}
                          environment={env.environment}
                        />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell to={path}>
                    {w.active ? (
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
            <TableBlankRow colSpan={100}>
              <Paragraph>No External triggers</Paragraph>
            </TableBlankRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}
