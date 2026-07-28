/**
 * How an honoured intent appears in the transcript, plus the demo interceptor's
 * inline outcome line.
 *
 * The bubble is the user's only record that the agent moved their screen, so it
 * states the action in the past tense and shows the deep link it used. In demo
 * mode the link is a button, not a `Link`: clicking it reports what *would* have
 * happened and navigates nowhere.
 *
 * The outcome text keeps the default colour — honoured vs rejected is carried by
 * the coloured icon, the same rule the run status cells follow.
 */
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  NoSymbolIcon,
} from "@heroicons/react/20/solid";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import { AgentStatusIcon } from "../../agent-badges";
import { ChatNote, ChatStatusLine } from "../../chat-layout";
import type { DemoIntent } from "../fixtures/intents";

/**
 * A neutral inline note — the demo interceptor's voice, never the agent's.
 * Unlabelled on purpose: fixture chats present as real ones for review.
 *
 * The note is a transcript-level format, so it lives in the chat layout library
 * as `ChatNote`; this is the demo's name for it.
 */
export const DemoNote = ChatNote;

export function DemoIntentBubble({
  intent,
  onIntercept,
}: {
  intent: DemoIntent;
  /** Called instead of acting. The host renders the result as a `DemoNote`. */
  onIntercept?: (message: string) => void;
}) {
  const rejected = !intent.executable;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-3",
        rejected
          ? "border-border-bright bg-background-bright/40"
          : "border-indigo-500/30 bg-indigo-500/5"
      )}
    >
      <ChatStatusLine
        icon={
          <AgentStatusIcon
            tone={rejected ? "error" : "success"}
            icon={rejected ? NoSymbolIcon : CheckCircleIcon}
            className="mt-px"
          />
        }
      >
        <p className="text-xs text-text-bright">{intent.outcome}</p>
        {intent.deepLinkLabel ? (
          <Button
            variant="secondary/small"
            LeadingIcon={ArrowTopRightOnSquareIcon}
            onClick={() =>
              onIntercept?.(
                `would navigate to ${intent.deepLinkLabel} (${
                  intent.intent.kind === "navigate" ? intent.intent.target : intent.intent.kind
                })`
              )
            }
          >
            <span className="break-all text-left font-mono text-[10px]">
              {intent.deepLinkLabel}
            </span>
          </Button>
        ) : null}
      </ChatStatusLine>
    </div>
  );
}
