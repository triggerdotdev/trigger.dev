/**
 * Renders one fixture conversation as a drop-in replacement for
 * `DashboardAgentChat`: same banner, same message renderer, same composer, no
 * transport and no LLM.
 *
 * Two rules hold this together:
 *
 * 1. **Real renderers only.** Messages go through the production
 *    `DashboardAgentTurns` (which is also what puts view-catalog blocks on
 *    screen), the banner and composer are the production components. The only
 *    demo-authored UI is the cards for payloads that don't exist yet
 *    (investigation, report) and the chart with canned rows.
 * 2. **Every affordance is intercepted.** Clicking a deep link, a report action,
 *    a prompt chip, a watch cancel or Send appends an inline demo note saying
 *    what *would* have happened. Nothing navigates, nothing is fetched, nothing
 *    is written.
 *
 * Layout is not this component's business. It owns one `ChatTranscript` and maps
 * each item kind onto a chat-layout micro-layout (see `../chat-layout` for the
 * rules); a "messages" item renders the production turns via
 * `DashboardAgentTurns` straight into that transcript, so a demo turn and a real
 * turn are laid out by the same code.
 */
import { useCallback, useState } from "react";
import { ChatCardSlot, ChatNote, ChatTranscript, ChatTurn } from "../chat-layout";
import { DashboardAgentComposer } from "../DashboardAgentComposer";
import { DashboardAgentContextBanner } from "../DashboardAgentContextBanner";
import { DashboardAgentTurns } from "../DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "../DashboardAgentSuggestedPrompts";
import { DemoChartCard } from "./components/DemoChartCard";
import { DemoIntentBubble } from "./components/DemoIntentBubble";
import { DemoInvestigationCard } from "./components/DemoInvestigationCard";
import { DemoReportCard } from "./components/DemoReportCard";
import { DemoSuggestedPromptsRow } from "./components/DemoSuggestedPromptsRow";
import { DemoWatchChips } from "./components/DemoWatchChips";
import { demoChatById, type DemoChat, type DemoItem } from "./demo-chats";

// No demo banner: fixture chats are presented exactly like real ones so the
// review judges the actual experience. Isolation stays mechanical (demo:* ids,
// no transport, no writes) — it never depended on the visual marker.

// #region chat-layout transcript
// Item kind → micro-layout. Nothing here sets its own spacing: every case is a
// `ChatTurn` (or the production turns) and one micro-layout from ../chat-layout.
// `chat-layout.test.ts` fails if a spacing utility class appears in this region.

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
    // Production turns, dropped straight into this view's transcript.
    case "messages":
      return (
        <DashboardAgentTurns
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
        <ChatTurn>
          <ChatCardSlot>
            <DemoInvestigationCard
              investigation={item.investigation}
              defaultExpanded={item.expanded}
            />
          </ChatCardSlot>
        </ChatTurn>
      );
    case "report":
      return (
        <ChatTurn>
          <ChatCardSlot>
            <DemoReportCard
              vm={item.report}
              sourceUri={item.sourceUri}
              onAction={(label, url) =>
                intercept(`would run "${label}"${url ? ` and open ${url}` : ""}`)
              }
            />
          </ChatCardSlot>
        </ChatTurn>
      );
    case "chart":
      return (
        <ChatTurn>
          <ChatCardSlot>
            <DemoChartCard title={item.title} />
          </ChatCardSlot>
        </ChatTurn>
      );
    case "intent":
      return (
        <ChatTurn>
          <ChatCardSlot>
            <DemoIntentBubble intent={item.intent} onIntercept={intercept} />
          </ChatCardSlot>
        </ChatTurn>
      );
    case "watches":
      return (
        <ChatTurn>
          <ChatCardSlot>
            <DemoWatchChips
              watches={item.watches}
              onCancel={(watch) => intercept(`would cancel the ${watch.chipLabel} watch`)}
            />
          </ChatCardSlot>
        </ChatTurn>
      );
    case "prompts":
      return (
        <ChatTurn>
          <ChatCardSlot>
            <DemoSuggestedPromptsRow
              prompts={item.prompts}
              context={item.context}
              dismissedIds={item.dismissedIds}
              onSelect={(prompt) => intercept(`would send: "${prompt.prompt}"`)}
              onDismiss={(prompt) => intercept(`would dismiss the "${prompt.label}" chip`)}
            />
          </ChatCardSlot>
        </ChatTurn>
      );
    case "note":
      return (
        <ChatTurn>
          <ChatNote>{item.text}</ChatNote>
        </ChatTurn>
      );
    // The banner spans the panel edge to edge — the one full-bleed insert.
    case "banner":
      return (
        <ChatTurn bleed>
          <DashboardAgentContextBanner
            projectSlug={item.projectSlug}
            environmentSlug={item.environmentSlug}
            currentPage={item.currentPage}
          />
        </ChatTurn>
      );
    default: {
      const unreachable: never = item;
      throw new Error(`Unhandled demo item: ${JSON.stringify(unreachable)}`);
    }
  }
}
// #endregion chat-layout transcript

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
        // #region chat-layout transcript
        <ChatTranscript>
          {chat.items.map((item, i) => (
            <DemoItemView
              key={i}
              item={item}
              isLast={i === chat.items.length - 1}
              chat={chat}
              intercept={intercept}
            />
          ))}

          {/* The intent log, newest last: one turn, one note per entry. */}
          {intercepted.length > 0 ? (
            <ChatTurn>
              {intercepted.map((message, i) => (
                <ChatNote key={i}>{message}</ChatNote>
              ))}
            </ChatTurn>
          ) : null}
        </ChatTranscript>
      ) : (
        // Empty / first-open: the production prompt panel, chips intercepted.
        // The intent log still needs a home here — sending from the draft case
        // must show its note, not vanish.
        <div className="flex-1 overflow-y-auto">
          <DashboardAgentSuggestedPrompts
            onSelect={(prompt) => intercept(`would send: "${prompt}"`)}
          />
          {intercepted.length > 0 ? (
            <ChatTranscript>
              <ChatTurn>
                {intercepted.map((message, i) => (
                  <ChatNote key={i}>{message}</ChatNote>
                ))}
              </ChatTurn>
            </ChatTranscript>
          ) : null}
        </div>
      )}
      {/* #endregion chat-layout transcript */}

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
