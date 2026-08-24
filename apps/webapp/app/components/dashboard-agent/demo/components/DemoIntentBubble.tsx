import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  NoSymbolIcon,
} from "@heroicons/react/20/solid";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import { AgentStatusIcon } from "../../agent-badges";
import { ChatStatusLine } from "../../chat-layout";
import type { DemoIntent } from "../fixtures/intents";

export function DemoIntentBubble({
  intent,
  onIntercept,
}: {
  intent: DemoIntent;
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
