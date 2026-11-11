import { GROUP_CAPABILITY_KEY } from "@internal/alert-contracts";
import { expiryToIso } from "~/components/alerts/createAlertRequest";
import type { AlertListRow } from "~/presenters/v3/alertListRow";

export const GROUP_ALERTS_PATH = "/resources/alerts/group";

export type GroupMode = "any" | "all";

export function isGroupable(row: AlertListRow): boolean {
  return row.status !== "inactive" && !row.groupId && row.capabilityKey !== GROUP_CAPABILITY_KEY;
}

export function defaultGroupName(count: number): string {
  return `Group of ${count} alerts`;
}

export function groupAlertsBody(
  ids: { organizationId: string; projectId: string; environmentId: string },
  draft: {
    compositeMode: GroupMode;
    name: string;
    notifiers: string[];
    expiry?: string;
  } & ({ memberAlertIds: string[] } | { members: object[] }),
  transcriptChatId?: string
) {
  const expiresAt = expiryToIso(draft.expiry);
  return {
    ...ids,
    ...("members" in draft ? { members: draft.members } : { memberAlertIds: draft.memberAlertIds }),
    compositeMode: draft.compositeMode,
    name: draft.name,
    notifierChannelIds: draft.notifiers,
    ...(expiresAt ? { expiresAt } : {}),
    ...(transcriptChatId ? { transcriptChatId } : {}),
  };
}
