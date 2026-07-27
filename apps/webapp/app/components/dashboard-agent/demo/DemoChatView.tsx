/**
 * Renders one fixture conversation as a drop-in replacement for
 * `DashboardAgentChat`: same banner, same message renderer, same composer, no
 * transport and no LLM.
 *
 * Two rules hold this together:
 *
 * 1. **Real renderers only.** Messages go through the production
 *    `DashboardAgentMessages` (which is also what puts view-catalog blocks on
 *    screen), the banner and composer are the production components. The only
 *    demo-authored UI is the cards for payloads that don't exist yet
 *    (investigation, report) and the chart with canned rows.
 * 2. **Every affordance is intercepted.** Clicking a deep link, a report action,
 *    a prompt chip, a watch cancel or Send appends an inline demo note saying
 *    what *would* have happened. Nothing navigates, nothing is fetched, nothing
 *    is written.
 *
 * A "messages" item nests `DashboardAgentMessages` inside this component's own
 * scroll container. That is intentional and safe: its root is `flex-1
 * overflow-y-auto`, which in a block-layout parent resolves to content height
 * with nothing to scroll, so the outer container does all the scrolling while
 * each segment keeps the production spacing.
 */
import { useCallback, useState } from "react";
import { DashboardAgentComposer } from "../DashboardAgentComposer";
import { DashboardAgentContextBanner } from "../DashboardAgentContextBanner";
import { DashboardAgentMessages } from "../DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "../DashboardAgentSuggestedPrompts";
import { DemoChartCard } from "./components/DemoChartCard";
import { DemoIntentBubble, DemoNote } from "./components/DemoIntentBubble";
import { DemoInvestigationCard } from "./components/DemoInvestigationCard";
import { DemoReportCard } from "./components/DemoReportCard";
import { DemoSuggestedPromptsRow } from "./components/DemoSuggestedPromptsRow";
import { DemoWatchChips } from "./components/DemoWatchChips";
import { demoChatById, type DemoChat, type DemoItem } from "./demo-chats";

/** The strip that makes it impossible to mistake demo mode for the real thing. */
function DemoModeBar({ chat }: { chat: DemoChat }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/5 px-3 py-1.5">
      <span className="rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
        demo
      </span>
      <span className="text-xs text-amber-200/80">{chat.title}</span>
      <span className="text-[10px] text-amber-200/50">
        {chat.resumed ? "resumed transcript · " : ""}all data is dummy
      </span>
    </div>
  );
}

function DemoItemView({
  item,
  isLast,
  chat,
  intercept,
}: {
  item: DemoItem;
  isLast: boolean;
  chat: DemoChat;
  intercept: (message: string) => void;
}) {
  switch (item.kind) {
    case "messages":
      return (
        <DashboardAgentMessages
          messages={item.messages}
          activity={isLast ? (chat.activity ?? null) : null}
          error={isLast && chat.error ? new Error(chat.error) : undefined}
          // The retry / dismiss affordances are the production ones; only their
          // handlers are swapped for the interceptor.
          onRetry={
            isLast && chat.error ? () => intercept("would retry the failed turn") : undefined
          }
          onDismissError={
            isLast && chat.error ? () => intercept("would dismiss the error") : undefined
          }
        />
      );
    case "investigation":
      return (
        <div className="px-4">
          <DemoInvestigationCard
            investigation={item.investigation}
            defaultExpanded={item.expanded}
          />
        </div>
      );
    case "report":
      return (
        <div className="px-4">
          <DemoReportCard
            vm={item.report}
            sourceUri={item.sourceUri}
            onAction={(label, url) =>
              intercept(`would run "${label}"${url ? ` and open ${url}` : ""}`)
            }
          />
        </div>
      );
    case "chart":
      return (
        <div className="px-4">
          <DemoChartCard title={item.title} />
        </div>
      );
    case "intent":
      return (
        <div className="px-4">
          <DemoIntentBubble intent={item.intent} onIntercept={intercept} />
        </div>
      );
    case "watches":
      return (
        <div className="px-4">
          <DemoWatchChips
            watches={item.watches}
            onCancel={(watch) => intercept(`would cancel the ${watch.chipLabel} watch`)}
          />
        </div>
      );
    case "prompts":
      return (
        <div className="px-4">
          <DemoSuggestedPromptsRow
            prompts={item.prompts}
            context={item.context}
            dismissedIds={item.dismissedIds}
            onSelect={(prompt) => intercept(`would send: "${prompt.prompt}"`)}
            onDismiss={(prompt) => intercept(`would dismiss the "${prompt.label}" chip`)}
          />
        </div>
      );
    case "note":
      return (
        <div className="px-4">
          <DemoNote>{item.text}</DemoNote>
        </div>
      );
    case "banner":
      return (
        <DashboardAgentContextBanner
          projectSlug={item.projectSlug}
          environmentSlug={item.environmentSlug}
          currentPage={item.currentPage}
        />
      );
    default: {
      const unreachable: never = item;
      throw new Error(`Unhandled demo item: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function DemoChatView({
  chatId,
  chat: chatProp,
  /** Real panel context, used when a fixture doesn't override the banner. */
  projectSlug = "demo-storefront",
  environmentSlug = "prod",
  currentPage = "runs",
}: {
  chatId?: string;
  chat?: DemoChat;
  projectSlug?: string;
  environmentSlug?: string;
  currentPage?: string;
}) {
  const chat = chatProp ?? (chatId ? demoChatById(chatId) : undefined);
  const [input, setInput] = useState(chat?.draft ?? "");
  // The intent log: what the demo would have done, newest last, rendered
  // inline at the bottom instead of being acted on.
  const [intercepted, setIntercepted] = useState<string[]>([]);

  const intercept = useCallback((message: string) => {
    setIntercepted((current) => [...current, message]);
  }, []);

  if (!chat) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-text-dimmed">
        No demo conversation with that id.
      </div>
    );
  }

  const banner = chat.banner ?? { projectSlug, environmentSlug, currentPage };
  const hasItems = chat.items.length > 0;

  return (
    <>
      <DemoModeBar chat={chat} />
      <DashboardAgentContextBanner
        projectSlug={banner.projectSlug}
        environmentSlug={banner.environmentSlug}
        currentPage={banner.currentPage}
      />
      {chat.headerWatches && chat.headerWatches.length > 0 ? (
        <div className="border-b border-grid-bright px-3 py-1.5">
          <DemoWatchChips
            watches={chat.headerWatches}
            onCancel={(watch) => intercept(`would cancel the ${watch.chipLabel} watch`)}
          />
        </div>
      ) : null}

      {hasItems ? (
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <div className="space-y-2 py-2">
            {chat.items.map((item, i) => (
              <DemoItemView
                key={i}
                item={item}
                isLast={i === chat.items.length - 1}
                chat={chat}
                intercept={intercept}
              />
            ))}

            {intercepted.length > 0 ? (
              <div className="space-y-1.5 px-4 pt-1">
                {intercepted.map((message, i) => (
                  <DemoNote key={i}>{message}</DemoNote>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        // Empty / first-open: the production prompt panel, chips intercepted.
        <DashboardAgentSuggestedPrompts
          onSelect={(prompt) => intercept(`would send: "${prompt}"`)}
        />
      )}

      <DashboardAgentComposer
        value={input}
        onChange={setInput}
        onSubmit={() => {
          const trimmed = input.trim();
          if (!trimmed) return;
          setInput("");
          intercept(`would send: "${trimmed}"`);
        }}
        onStop={() => intercept("would stop the turn")}
        isStreaming={Boolean(chat.activity)}
      />
    </>
  );
}
