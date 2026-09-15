/**
 * What a submitted watch card leaves in the transcript, in two flavours.
 *
 * A confirmation states the watch's lifetime facts and is the only transcript record
 * of the request. A one-shot result means the immediate check answered outright and
 * no watch was created, so no chip appears, no wake arrives and there is nothing to
 * cancel.
 *
 * Pure component: the wording is not computed here, it was frozen into the block at
 * append time by `app/presenters/v3/dashboardAgent`, so a later copy change never rewrites what
 * a user was already told.
 */
import { CheckCircleIcon, EyeIcon, InformationCircleIcon } from "@heroicons/react/20/solid";
import type { WatchResultBlock as WatchResultBlockPayload } from "@internal/dashboard-agent-contracts";
import { ChatSystemBlock } from "./chat-layout";
import { TONE_ICON_COLOR } from "./agent-badges";
import { cn } from "~/utils/cn";

/**
 * Every outcome keeps a static icon. Nothing animates: the block is frozen at append time
 * and never hears that the watch fired, expired or was cancelled, so an animated label
 * would still be running on a watch that ended hours ago. Live state is the chips' job.
 */
const OUTCOME = {
  watching: {
    label: "Watch",
    icon: <EyeIcon className="size-3.5 shrink-0 text-text-dimmed" />,
  },
  already_true: {
    label: "Watch",
    icon: <CheckCircleIcon className={cn("size-3.5 shrink-0", TONE_ICON_COLOR.success)} />,
  },
  impossible: {
    label: "Watch",
    icon: <InformationCircleIcon className={cn("size-3.5 shrink-0", TONE_ICON_COLOR.neutral)} />,
  },
} as const;

export function WatchResultBlock({ block }: { block: WatchResultBlockPayload }) {
  const outcome = OUTCOME[block.outcome] ?? OUTCOME.watching;
  const { label, icon } = outcome;

  return (
    <ChatSystemBlock label={label} icon={icon}>
      <p className="text-sm text-text-bright">{block.headline}</p>
      {block.lifetime ? <p className="text-xs text-text-dimmed">{block.lifetime}</p> : null}
      {block.detail ? <p className="text-xs text-text-dimmed">{block.detail}</p> : null}
      {(block.followUp ?? []).map((line) => (
        <p key={line} className="text-xs text-text-dimmed">
          {line}
        </p>
      ))}
    </ChatSystemBlock>
  );
}
