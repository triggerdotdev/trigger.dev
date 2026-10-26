import type { ActivityRowLink } from "~/components/alerts/AlertActivityTable";
import type { AlertDetail, AlertDetailEvent } from "~/presenters/v3/AlertDetailPresenter.server";
import { concurrencyQueuePath, v3ErrorPath, v3RunsPath } from "~/utils/pathBuilder";

type PathScope = {
  organization: Parameters<typeof v3RunsPath>[0];
  project: Parameters<typeof v3RunsPath>[1];
  environment: Parameters<typeof v3RunsPath>[2];
};

const RUNS_LINKABLE_AREAS = new Set(["runs", "queues"]);

export function activityRowLink(
  alert: Pick<AlertDetail, "area" | "windowSec" | "scope" | "objectLink">,
  event: AlertDetailEvent,
  { organization, project, environment }: PathScope
): ActivityRowLink | undefined {
  if (event.fingerprint) {
    return {
      to: v3ErrorPath(organization, project, environment, { fingerprint: event.fingerprint }),
      label: "View error",
      kind: "error",
    };
  }
  const closing = event.type === "raised" || event.type === "recovered";
  if (closing && alert.scope.type === "queue" && alert.objectLink?.kind === "queue") {
    return {
      to: concurrencyQueuePath(organization, project, environment, {
        friendlyId: alert.objectLink.friendlyId,
      }),
      label: "View queue",
      kind: "queue",
    };
  }
  if (closing && RUNS_LINKABLE_AREAS.has(alert.area) && alert.windowSec) {
    const to = event.at.getTime();
    const from = to - alert.windowSec * 1000;
    return {
      to: v3RunsPath(organization, project, environment, {
        from,
        to,
        ...(alert.scope.type === "task" ? { tasks: [alert.scope.taskIdentifier] } : {}),
      }),
      label: "View related runs",
      kind: "runs",
    };
  }
  return undefined;
}
