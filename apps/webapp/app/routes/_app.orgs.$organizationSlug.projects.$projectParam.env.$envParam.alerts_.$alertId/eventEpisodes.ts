import { formatDistance } from "date-fns";
import type { AlertDetailEvent } from "~/presenters/v3/AlertDetailPresenter.server";

export type EventEpisode = {
  closedBy?: AlertDetailEvent;
  entries: AlertDetailEvent[];
};

export function eventEpisodes(events: AlertDetailEvent[]): EventEpisode[] {
  const oldest = [...events].reverse();
  const episodes: EventEpisode[] = [];
  let entries: AlertDetailEvent[] = [];

  for (const event of oldest) {
    if (event.type === "resolved" || event.type === "stopped" || event.type === "expired") {
      episodes.push({ closedBy: event, entries });
      entries = [];
      continue;
    }
    entries.push(event);
  }
  if (entries.length > 0) episodes.push({ entries });
  return episodes;
}

export function episodeNote(
  closedBy: AlertDetailEvent,
  resolvedByLabel: string | null | undefined,
  now: Date,
  stoppedByLabel?: string | null
): string {
  const note = `${closedBy.type} ${formatDistance(closedBy.at, now, { addSuffix: true })}`;
  const by = closedBy.type === "stopped" ? stoppedByLabel : resolvedByLabel;
  return by && (closedBy.type === "resolved" || closedBy.type === "stopped")
    ? `${note} by ${by}`
    : note;
}
