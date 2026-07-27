/**
 * How an honoured intent appears in the transcript, plus the demo interceptor's
 * inline outcome line.
 *
 * The bubble is the user's only record that the agent moved their screen, so it
 * states the action in the past tense and shows the deep link it used. In demo
 * mode the link is a button, not a `Link`: clicking it reports what *would* have
 * happened and navigates nowhere.
 */
import { ArrowTopRightOnSquareIcon, NoSymbolIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import type { DemoIntent } from "../fixtures/intents";

/**
 * A neutral inline note — the demo interceptor's voice, never the agent's.
 * Unlabelled on purpose: fixture chats present as real ones for review.
 */
export function DemoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border-bright bg-background-bright/40 px-2.5 py-1.5">
      <span className="text-xs text-text-dimmed">{children}</span>
    </div>
  );
}

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
        "rounded-md border px-2.5 py-2",
        rejected
          ? "border-border-bright bg-background-bright/40"
          : "border-indigo-500/30 bg-indigo-500/5"
      )}
    >
      <div className="flex items-start gap-1.5">
        {rejected ? (
          <NoSymbolIcon className="mt-0.5 size-3.5 shrink-0 text-text-dimmed" />
        ) : (
          <ArrowTopRightOnSquareIcon className="mt-0.5 size-3.5 shrink-0 text-indigo-400" />
        )}
        <div className="min-w-0 space-y-1">
          <p className={cn("text-xs", rejected ? "text-text-dimmed" : "text-text-bright")}>
            {intent.outcome}
          </p>
          {intent.deepLinkLabel ? (
            <button
              type="button"
              onClick={() =>
                onIntercept?.(
                  `would navigate to ${intent.deepLinkLabel} (${
                    intent.intent.kind === "navigate" ? intent.intent.target : intent.intent.kind
                  })`
                )
              }
              className="break-all text-left font-mono text-[10px] text-indigo-400 underline decoration-dotted hover:text-indigo-300"
            >
              {intent.deepLinkLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
