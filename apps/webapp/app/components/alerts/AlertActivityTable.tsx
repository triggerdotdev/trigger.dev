import { formatDistance } from "date-fns";
import { Fragment } from "react";
import { BugIcon } from "~/assets/icons/BugIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { LogLevel } from "~/components/logs/LogLevel";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import type { AlertDetail, AlertDetailEvent } from "~/presenters/v3/AlertDetailPresenter.server";
import type { LogLevel as LogLevelValue } from "~/utils/logUtils";
import {
  episodeNote,
  eventEpisodes,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.$alertId/eventEpisodes";

const EVENT_LEVEL = {
  raised: "ERROR",
  recovered: "INFO",
  resolved: "INFO",
  expired: "WARN",
  stopped: "WARN",
} as const satisfies Record<AlertDetailEvent["type"], LogLevelValue>;

type AlertLevel = (typeof EVENT_LEVEL)[AlertDetailEvent["type"]];

const EVENT_LABEL: Record<AlertDetailEvent["type"], string> = {
  raised: "Raised",
  recovered: "Recovered",
  resolved: "Resolved",
  expired: "Expired",
  stopped: "Stopped",
};

export const LEVEL_DESCRIPTIONS: Record<AlertLevel, string> = {
  ERROR: "The condition was met and the alert was raised.",
  WARN: "The alert expired or was stopped.",
  INFO: "The condition recovered or you resolved the alert.",
};

export function LevelBreakdown() {
  return (
    <div className="flex flex-col gap-2.5">
      {(Object.keys(LEVEL_DESCRIPTIONS) as AlertLevel[]).map((level) => (
        <div key={level} className="flex flex-col items-start gap-1">
          <LogLevel level={level} />
          <span>{LEVEL_DESCRIPTIONS[level]}</span>
        </div>
      ))}
    </div>
  );
}

export type ActivityRowLink = { to: string; label: string; kind: "runs" | "error" | "queue" };

function EpisodeHeaderRow({ title, note }: { title: string; note?: string }) {
  return (
    <TableRow>
      <TableCell colSpan={3} className="bg-charcoal-800/40">
        <span className="flex items-center gap-2 text-xs">
          <span className="font-medium text-text-bright">{title}</span>
          {note && <span className="text-text-dimmed">{note}</span>}
        </span>
      </TableCell>
    </TableRow>
  );
}

function RowLink({ link }: { link: ActivityRowLink }) {
  const Icon = { error: BugIcon, queue: QueuesIcon, runs: RunsIcon }[link.kind];
  return (
    <span className="ml-auto opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <LinkButton
        variant="minimal/small"
        className="aspect-square px-1!"
        LeadingIcon={Icon}
        leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
        to={link.to}
        tooltip={link.label}
        aria-label={link.label}
      />
    </span>
  );
}

export function AlertActivityTable({
  alert,
  now,
  rowLink,
}: {
  alert: AlertDetail;
  now: Date;
  rowLink: (event: AlertDetailEvent) => ActivityRowLink | undefined;
}) {
  if (alert.events.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-text-dimmed">
        No activity yet.
      </div>
    );
  }

  const episodes = eventEpisodes(alert.events).reverse();

  return (
    <Table variant="dimmed" showTopBorder={false}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell className="whitespace-nowrap">Time</TableHeaderCell>
          <TableHeaderCell
            tooltip={<LevelBreakdown />}
            disableTooltipHoverableContent
            tooltipContentClassName="max-w-sm"
          >
            Level
          </TableHeaderCell>
          <TableHeaderCell className="w-full">Event</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {episodes.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {group.closedBy && (
              <EpisodeHeaderRow
                title="Closed episode"
                note={episodeNote(group.closedBy, alert.resolvedByLabel, now, alert.stoppedByLabel)}
              />
            )}
            {[...group.entries].reverse().map((event) => {
              const link = rowLink(event);
              return (
                <TableRow key={event.id} className="group">
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <span title={formatDistance(event.at, now, { addSuffix: true })}>
                      <DateTime date={event.at} showTooltip={false} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <LogLevel level={EVENT_LEVEL[event.type]} />
                  </TableCell>
                  <TableCell className="pr-2 text-text-bright">
                    <span className="flex w-full items-center gap-2">
                      <span title={event.factsSummary || undefined}>{EVENT_LABEL[event.type]}</span>
                      {link && <RowLink link={link} />}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
