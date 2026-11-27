import { type ReactNode } from "react";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { CopyableText } from "~/components/primitives/CopyableText";
import {
  DetailHeader,
  DetailPage,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
} from "~/components/primitives/detail/DetailPage";
import { DetailTableTab, DetailTabEmpty } from "~/components/primitives/detail/DetailSections";
import { TextLink } from "~/components/primitives/TextLink";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import type { ScheduleCalendar } from "~/v3/scheduleUpcoming.server";
import { type ScheduleCalendarNav, ScheduleUpcomingCalendar } from "./ScheduleUpcomingCalendar";
import { ScheduleUpcomingDense } from "./ScheduleUpcomingDense";
import { OpenScheduleRunsLink, type ScheduleDetail, shortUntil, useNow } from "./ScheduleViews";

/*
 * A schedule's page on the detail template, like a deployment or a bulk action: identity and
 * actions in the header, Upcoming and Runs tabs, the settings in the rail. New schedule and Edit
 * are the centered dialog.
 */

export type SchedulePageTab = "upcoming" | "runs";

export function SchedulePageView({
  schedule,
  calendar,
  calendarLoading,
  calendarNav,
  runs,
  taskLink,
  tab,
  onTabChange,
  secondaryActions,
  primaryAction,
  enableAction,
  loadedAt,
}: {
  schedule: ScheduleDetail & { minimumWindowDurationSeconds?: number | null };
  /** The Upcoming tab: the days it runs and the picked day's runs. */
  calendar: ScheduleCalendar | undefined;
  /** The calendar the URL asks for is still loading, and the last one is shown meanwhile. */
  calendarLoading?: boolean;
  /** The page changes the calendar in place; without it the calendar's links navigate. */
  calendarNav?: ScheduleCalendarNav;
  /** The schedule's runs for the Runs tab (more than the five on the schedule). */
  runs: ScheduleDetail["runs"];
  /** The task page, for the rail's Task property. */
  taskLink: string;
  tab: SchedulePageTab;
  onTabChange: (tab: SchedulePageTab) => void;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
  /** The Upcoming tab shows it on a disabled schedule. */
  enableAction?: ReactNode;
  /** When the loader ran, in epoch ms: the clock the first render uses. */
  loadedAt?: number;
}) {
  const next = schedule.active ? schedule.nextRuns[0] : undefined;
  const isImperative = schedule.type === "IMPERATIVE";
  const now = useNow(30_000, loadedAt);

  return (
    <DetailPage
      id="schedule"
      header={
        <DetailHeader
          icon={ClockIcon}
          iconClassName="text-schedules"
          title={schedule.externalId ?? schedule.friendlyId}
          mono
          friendlyId={schedule.friendlyId}
          status={<EnabledStatus enabled={schedule.active} />}
          meta={[
            <ScheduleTypeCombo key="type" type={schedule.type} className="text-xs" />,
            <span key="cron" className="truncate">
              {schedule.cronDescription} ({schedule.timezone})
            </span>,
            <span key="next">
              {next ? `Next run ${shortUntil(new Date(next.effectiveAt), now)}` : "Not running"}
            </span>,
          ]}
          secondaryActions={secondaryActions}
          primaryAction={primaryAction}
        />
      }
      tabs={
        <DetailTabs<SchedulePageTab>
          tabs={[
            { id: "upcoming", label: "Upcoming" },
            { id: "runs", label: "Runs", count: runs.length > 0 ? String(runs.length) : undefined },
          ]}
          activeTab={tab}
          onTabChange={onTabChange}
          layoutId="schedule-tab"
        />
      }
      rail={
        <PropertyRail>
          <PropertyGroup title="Schedule">
            <PropertyPair>
              <DetailProperty label="Cron">
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs text-text-bright">{schedule.cron}</span>
                  <span className="text-xs text-text-dimmed">{schedule.cronDescription}</span>
                </span>
              </DetailProperty>
              <DetailProperty label="Timezone">{schedule.timezone}</DetailProperty>
              <DetailProperty label="Window">
                {`${schedule.window ?? "–"}${
                  schedule.windowSource === "schedule_default" ? " (default)" : ""
                }`}
              </DetailProperty>
              <DetailProperty label="Environment">
                {schedule.environments.map((env) => (
                  <EnvironmentCombo key={env.id} environment={env} className="text-xs" />
                ))}
              </DetailProperty>
            </PropertyPair>
          </PropertyGroup>
          <PropertyGroup title="Details">
            <PropertyPair>
              <DetailProperty label="Schedule ID">
                <CopyableText value={schedule.friendlyId} className="font-mono text-xs" />
              </DetailProperty>
              <DetailProperty label="Task">
                <TextLink to={taskLink} className="font-mono text-xs">
                  {schedule.taskIdentifier}
                </TextLink>
              </DetailProperty>
              <DetailProperty label="Type">
                <ScheduleTypeCombo type={schedule.type} className="text-sm" />
              </DetailProperty>
              {isImperative ? (
                <>
                  <DetailProperty label="External ID">
                    {schedule.externalId ? (
                      <CopyableText value={schedule.externalId} className="font-mono text-xs" />
                    ) : (
                      "–"
                    )}
                  </DetailProperty>
                  <DetailProperty label="Deduplication key">
                    {schedule.userProvidedDeduplicationKey && schedule.deduplicationKey ? (
                      <CopyableText
                        value={schedule.deduplicationKey}
                        className="font-mono text-xs"
                      />
                    ) : (
                      "–"
                    )}
                  </DetailProperty>
                </>
              ) : (
                <DetailProperty label="Defined in">
                  <span className="text-xs text-text-dimmed">
                    <span className="font-mono text-text-bright">schedules.task</span>, edit it
                    there and deploy
                  </span>
                </DetailProperty>
              )}
            </PropertyPair>
          </PropertyGroup>
        </PropertyRail>
      }
    >
      {tab === "runs" ? (
        runs.length === 0 ? (
          <DetailTabEmpty
            title="No runs yet"
            description={
              schedule.active
                ? "Runs from this schedule show up here after its first run."
                : "This schedule is disabled. Enable it to start running."
            }
          />
        ) : (
          <DetailTableTab actions={<OpenScheduleRunsLink schedule={schedule} />}>
            <TaskRunsTable
              total={runs.length}
              hasFilters={false}
              filters={{ tasks: [], versions: [], statuses: [], from: undefined, to: undefined }}
              runs={runs}
              isLoading={false}
              variant="dimmed"
              showTopBorder={false}
              stickyHeader
              disableAdjacentRows
              enableSmartColumns={false}
            />
          </DetailTableTab>
        )
      ) : calendar?.dense ? (
        // Every day is the same, so there's no calendar to draw: the rhythm instead.
        <ScheduleUpcomingDense
          schedule={schedule}
          now={now}
          calendar={calendar}
          loading={calendarLoading}
          enableAction={enableAction}
          nav={calendarNav}
        />
      ) : (
        <ScheduleUpcomingCalendar
          schedule={schedule}
          now={now}
          calendar={calendar}
          loading={calendarLoading}
          enableAction={enableAction}
          nav={calendarNav}
        />
      )}
    </DetailPage>
  );
}
