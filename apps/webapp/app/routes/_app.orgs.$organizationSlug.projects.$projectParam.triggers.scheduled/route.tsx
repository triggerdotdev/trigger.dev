import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/solid";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { DateTime } from "~/components/primitives/DateTime";
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
import { ScheduledTriggersPresenter } from "~/presenters/ScheduledTriggersPresenter.server";
import { requireUser } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  ProjectParamSchema,
  externalTriggerPath,
  trimTrailingSlash,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const presenter = new ScheduledTriggersPresenter();
  const data = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
  });

  return typedjson(data);
};

export const handle: Handle = {
  breadcrumb: (match) => (
    <BreadcrumbLink
      to={trimTrailingSlash(match.pathname)}
      title="Scheduled Triggers"
    />
  ),
  expandSidebar: true,
};

export default function Integrations() {
  const { scheduled } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <>
      <Paragraph variant="small" spacing>
        A Scheduled Trigger runs a Job on a repeated schedule. The schedule can
        use a CRON expression or an interval.
      </Paragraph>
      <Table containerClassName="mt-4">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>ID</TableHeaderCell>
            <TableHeaderCell>Schedule</TableHeaderCell>
            <TableHeaderCell>Dynamic</TableHeaderCell>
            <TableHeaderCell>Last run</TableHeaderCell>
            <TableHeaderCell>Next run</TableHeaderCell>
            <TableHeaderCell>Environment</TableHeaderCell>
            <TableHeaderCell>Active</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scheduled.length > 0 ? (
            scheduled.map((t) => {
              return (
                <TableRow
                  key={t.id}
                  className={cn(!t.active && "bg-rose-500/30")}
                >
                  <TableCell>{t.key}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {t.schedule.type === "cron" ? (
                        <>
                          <NamedIcon name="schedule-cron" className="h-8 w-8" />
                          <LabelValueStack
                            label={"CRON"}
                            value={t.schedule.options.cron}
                            variant="primary"
                          />
                        </>
                      ) : (
                        <>
                          <NamedIcon
                            name="schedule-interval"
                            className="h-8 w-8"
                          />
                          <LabelValueStack
                            label={"Interval"}
                            value={`${t.schedule.options.seconds}s`}
                            variant="primary"
                          />
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {t.dynamicTrigger ? (
                      <span className="flex items-center gap-0.5">
                        <NamedIcon name="dynamic" className="h-4 w-4" />
                        {t.dynamicTrigger.slug}
                      </span>
                    ) : (
                      <span className="text-dimmed">–</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {t.lastEventTimestamp ? (
                      <DateTime date={t.lastEventTimestamp} />
                    ) : (
                      "–"
                    )}
                  </TableCell>
                  <TableCell>
                    {t.nextEventTimestamp ? (
                      <DateTime date={t.nextEventTimestamp} />
                    ) : (
                      "–"
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex">
                      <EnvironmentLabel environment={t.environment} />
                    </span>
                  </TableCell>
                  <TableCell>
                    {t.active ? (
                      <CheckCircleIcon className="h-6 w-6 text-green-500" />
                    ) : (
                      <XCircleIcon className="h-6 w-6 text-rose-500" />
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          ) : (
            <TableBlankRow colSpan={5}>
              <Paragraph>No Scheduled triggers</Paragraph>
            </TableBlankRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}
