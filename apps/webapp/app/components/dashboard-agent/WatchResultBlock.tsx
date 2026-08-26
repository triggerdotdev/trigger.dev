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
import { CheckCircleIcon, InformationCircleIcon } from "@heroicons/react/20/solid";
import type { WatchResultBlock as WatchResultBlockPayload } from "@internal/dashboard-agent-contracts";
import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { ChatSystemBlock } from "./chat-layout";
import { TONE_ICON_COLOR } from "./agent-badges";
import { cn } from "~/utils/cn";

/**
 * Icon and label per outcome. A confirmation is not a success (nothing has happened
 * yet) so it wears the neutral Ask Trigger glyph; the check belongs to the one-shot
 * that did answer the question.
 */
const OUTCOME = {
  watching: { label: "Watch", icon: <AgentMonoLogo size={14} decorative /> },
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
  const { label, icon } = OUTCOME[block.outcome] ?? OUTCOME.watching;

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
