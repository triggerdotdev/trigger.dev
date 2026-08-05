import type { UIMessage } from "@ai-sdk/react";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import {
  demoChatById,
  demoFixtures,
  demoId,
  DemoIntentBubble,
} from "~/components/dashboard-agent/demo";
import { ChatProgress, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { DashboardAgentComposer } from "~/components/dashboard-agent/DashboardAgentComposer";
import { DashboardAgentContextBanner } from "~/components/dashboard-agent/DashboardAgentContextBanner";
import { DashboardAgentHero } from "~/components/dashboard-agent/DashboardAgentHero";
import { DashboardAgentMessages } from "~/components/dashboard-agent/DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "~/components/dashboard-agent/DashboardAgentSuggestedPrompts";
import { AgentPanelColumn } from "~/components/dashboard-agent/panel-layout";
import { liveProgress } from "~/components/dashboard-agent/progress-line";
import { resolveSuggestedPrompts } from "~/components/dashboard-agent/suggested-prompts";
import type { WakeWatch } from "~/components/dashboard-agent/WakeBanner";
import { WatchChips, type WatchChip } from "~/components/dashboard-agent/WatchChips";
import { cn } from "~/utils/cn";
import { chatMessages, investigationBlock } from "./fixtures";
import { fixtureResolveUri, GalleryPage, Missing, noop, PANEL_FRAME } from "./gallery";

// The chat chrome gallery: hero, prompts, transcript, wake banners, watch chips and
// the context banner. The card catalogs are on their own pages, see `./manifest.ts`.

const { demoIntents, demoWatches, demoPageContexts, demoInvestigations } = demoFixtures;

/**
 * `DashboardAgentMessages` in isolation. Its root is `flex-1 overflow-y-auto`, which
 * in a plain block parent resolves to content height with nothing to scroll, so the
 * whole transcript is visible and screenshotable.
 */
function MessageHarness({
  chatId,
  /** Render the panel's error row and its retry affordance. */
  withError = false,
  /**
   * Keep only the first N turns of the fixture. Used to isolate one state from a
   * conversation that goes on to show others.
   */
  take,
}: {
  chatId: string;
  withError?: boolean;
  take?: number;
}) {
  const chat = demoChatById(chatId);
  if (!chat) {
    return <Missing what={`demo chat ${chatId}`} />;
  }
  return (
    <div className={PANEL_FRAME}>
      <DashboardAgentMessages
        messages={chatMessages(chatId, take)}
        activity={chat.activity ?? null}
        error={withError && chat.error ? new Error(chat.error) : undefined}
        onRetry={withError ? noop : undefined}
        onDismissError={withError ? noop : undefined}
      />
    </div>
  );
}

/**
 * A label sheet, not a transcript: a real turn shows one progress line, relabelled as
 * it goes, so the phrasing has to hold up read as a set. The last tool is one the
 * label map doesn't know, showing the `Running <name>` fallback.
 *
 * Labels come from `liveProgress`, the same decision the panel makes, so the sheet
 * can't drift from what ships.
 */
const PENDING_PILL_TOOLS: { tool: string; input: unknown }[] = [
  { tool: "render_view", input: { blocks: [{ type: "diagnosis" }] } },
  { tool: "get_report", input: { window: "24h" } },
  { tool: "get_run", input: { runId: "run_demo" } },
  { tool: "run_query", input: { query: "SELECT count() FROM task_runs" } },
  { tool: "search_docs", input: { query: "concurrency limits" } },
  { tool: "brand_new_tool", input: {} },
];

function PendingPillsHarness() {
  const lines = PENDING_PILL_TOOLS.map(({ tool, input }) => ({
    tool,
    progress: liveProgress(
      [
        demoFixtures.assistantMessage(`pending-${tool}`, [
          demoFixtures.pendingToolPart(tool, input, `pending-${tool}`),
        ]),
      ],
      "working"
    ),
  }));
  return (
    <div className={PANEL_FRAME}>
      <ChatTranscript>
        {lines.map(({ tool, progress }) => (
          <ChatTurn key={tool}>
            <ChatProgress>{progress?.label}</ChatProgress>
          </ChatTurn>
        ))}
      </ChatTranscript>
    </div>
  );
}

/**
 * The real `DashboardAgentSuggestedPrompts`, fed a fixture page context. Chips come
 * from the registry resolver, so ordering and the cap match the panel. Passing
 * `dismissedIds` puts the component in controlled mode, keeping the gallery out of
 * localStorage.
 */
function PromptsHarness({
  context,
  promoted,
  dismissedIds = [],
}: {
  context: AgentPageContext;
  promoted?: SuggestedPrompt;
  dismissedIds?: string[];
}) {
  const signals =
    context.signals.length > 0 ? context.signals.map((s) => s.kind).join(", ") : "no signals";
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-wide text-text-faint">
        {context.page.kind} — {signals}
      </p>
      <div className={cn(PANEL_FRAME, "py-4")}>
        <DashboardAgentSuggestedPrompts
          onSelect={noop}
          pageContext={context}
          promoted={promoted}
          dismissedIds={dismissedIds}
        />
      </div>
    </div>
  );
}

/**
 * The real blank-state hero. `fullscreen` switches the wrapping `AgentPanelColumn` to
 * the takeover's centred column, the same component the panel uses, so the reading
 * width is the real one. The empty-chat state passes no composer because its composer
 * is docked below.
 */
function HeroHarness({
  context,
  promoted,
  fullscreen = false,
  withComposer = true,
}: {
  context: AgentPageContext;
  promoted?: SuggestedPrompt;
  fullscreen?: boolean;
  withComposer?: boolean;
}) {
  const [input, setInput] = useState("");
  return (
    <div className={cn(PANEL_FRAME, "flex h-[30rem] flex-col", fullscreen && "w-[60rem]")}>
      <AgentPanelColumn fullscreen={fullscreen}>
        <DashboardAgentHero
          onSelect={noop}
          pageContext={context}
          promoted={promoted}
          dismissedIds={[]}
          composer={
            withComposer ? (
              <DashboardAgentComposer
                layout="hero"
                autoFocus={false}
                value={input}
                onChange={setInput}
                onSubmit={noop}
                onStop={noop}
                isStreaming={false}
                context={
                  <DashboardAgentContextBanner
                    projectSlug="demo-storefront"
                    environmentSlug="prod"
                    currentPage="Runs"
                  />
                }
              />
            ) : undefined
          }
        />
      </AgentPanelColumn>
    </div>
  );
}

/**
 * A live investigation through the production renderer. The card carries no spinner of
 * its own: the turn's single progress line sits at the bottom of the transcript
 * wearing the card's phrase, which is why the spinner never restarts.
 */
function LiveInvestigationHarness() {
  const messages: UIMessage[] = [
    demoFixtures.userMessage("live-inv-q", "Why did this run fail?"),
    demoFixtures.assistantMessage("live-inv", [
      demoFixtures.renderViewPart(
        [investigationBlock(demoInvestigations.streamingRev1)],
        "render-live-investigation"
      ),
    ]),
  ];
  return (
    <div className={PANEL_FRAME}>
      <DashboardAgentMessages
        messages={messages}
        activity="working"
        resolveUri={fixtureResolveUri}
      />
    </div>
  );
}

// A stand-in for whatever the `promotedDashboardAgentPrompt` flag holds in production.
const promotedPrompt: SuggestedPrompt = {
  id: "sp:promo-storybook",
  label: "Try the new health report",
  prompt: "Give me a health report for this environment.",
  source: "promoted",
};

// Dismiss whatever the resolver puts first, so the state still shows a real chip
// having been removed when the registry's wording changes.
const dismissedPromptIds = resolveSuggestedPrompts(demoPageContexts.failedRun)
  .slice(0, 1)
  .map((prompt) => prompt.id);

/** A watch fixture in the shape the panel's loader hands to `WatchChips`. */
function toWatchChip(watch: (typeof demoWatches.row)[number]): WatchChip {
  return {
    id: watch.id,
    identity: watch.identity,
    status: watch.status,
    kind: watch.spec.kind,
    note: watch.spec.note,
    checkEveryMinutes: watch.spec.checkEveryMinutes,
    expiresAt: watch.expiresAt,
  };
}

// Wake fixtures live here rather than in the demo conversations: a wake is a message
// id plus the watch it names, and no demo chat carries one.

/** A wake narration, in the shape the panel merges live stream and history into. */
function wakeMessage(watchId: string, outcome: "fired" | "expired", text: string): UIMessage {
  return {
    id: `wake:watch:${watchId}:${outcome}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

/** One watch per presentation category the banner can reach. */
const wakeWatches: WakeWatch[] = [
  {
    id: "watch_health",
    kind: "health_recovery",
    note: "prod health back to normal",
    identity: "health_recovery:health",
    resolution: "condition_met",
    observedOutcome: { kind: "health_recovery", verified: true, severity: "ok" },
  },
  {
    id: "watch_error",
    kind: "error_recurrence",
    note: "tell me if that TypeError comes back",
    identity: "error_recurrence:a1b2c3d4e5f6",
    resolution: "condition_met",
    observedOutcome: { kind: "error_recurrence", verified: true, countSince: 6 },
  },
  {
    id: "watch_queue_gone",
    kind: "backlog_drain",
    note: "tell me when the email-sends backlog clears",
    identity: "backlog_drain:email-sends",
    resolution: "condition_impossible",
    observedOutcome: { kind: "backlog_drain", verified: true, depth: null },
  },
  {
    id: "watch_unverified",
    kind: "backlog_drain",
    note: "tell me when the email-sends backlog clears",
    identity: "backlog_drain:email-sends",
    resolution: "window_completed",
    observedOutcome: { kind: "backlog_drain", verified: false, depth: null },
  },
];

/** One wake through the production renderer, with the watches the panel would have. */
function WakeHarness({ message, watches }: { message: UIMessage; watches?: WakeWatch[] }) {
  return (
    <div className={PANEL_FRAME}>
      <DashboardAgentMessages messages={[message]} activity={null} watches={watches} />
    </div>
  );
}

// Keyed by `sectionId`, so the manifest drives what renders.
const STATES: Record<string, React.ReactNode> = {
  "hero-panel": <HeroHarness context={demoPageContexts.other} />,
  "hero-panel-contextual": <HeroHarness context={demoPageContexts.failedRun} />,
  "hero-fullscreen": <HeroHarness context={demoPageContexts.failedRun} fullscreen />,
  "hero-in-chat": <HeroHarness context={demoPageContexts.runs} withComposer={false} />,

  "prompts-default": <PromptsHarness context={demoPageContexts.other} />,
  "prompts-contextual-fresh-failure": <PromptsHarness context={demoPageContexts.failedRun} />,
  "prompts-promoted": (
    <PromptsHarness context={demoPageContexts.failedRun} promoted={promotedPrompt} />
  ),
  "prompts-dismissed": (
    <PromptsHarness context={demoPageContexts.failedRun} dismissedIds={dismissedPromptIds} />
  ),

  "messages-streaming-text": <MessageHarness chatId={demoId("base-streaming")} />,
  "messages-reasoning": <MessageHarness chatId={demoId("investigate-streaming")} />,
  "messages-tool-in-flight": <MessageHarness chatId={demoId("base-tool-in-flight")} />,
  "messages-tool-pending-pills": <PendingPillsHarness />,
  "messages-error-retry": <MessageHarness chatId={demoId("base-error-retry")} withError />,
  // Two turns only: the resumed chat's third turn is a live `chart` block, and
  // the real AgentChart has no environment to query outside a project route.
  "messages-render-view": <MessageHarness chatId={demoId("base-resumed")} take={2} />,
  "messages-investigation-live": <LiveInvestigationHarness />,
  "messages-docs-sources": <MessageHarness chatId={demoId("docs-answer")} />,

  "intent-navigate-filtered-runs": (
    <DemoIntentBubble intent={demoIntents.navigateToFailedRuns} onIntercept={noop} />
  ),
  "intent-watch": <DemoIntentBubble intent={demoIntents.watch} onIntercept={noop} />,
  "intent-rejected-propose-fix": (
    <DemoIntentBubble intent={demoIntents.proposeFix} onIntercept={noop} />
  ),

  "wake-positive": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_health",
        "fired",
        "Production is back to normal: the failure rate has been under 1% for the last 15 minutes and the queue has drained. Nothing left for me to watch here."
      )}
    />
  ),
  "wake-attention": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_error",
        "fired",
        "That TypeError is back — 6 runs of process-order failed with it in the last 10 minutes, all on version 20260620.2. Same empty-items payload as before."
      )}
    />
  ),
  "wake-neutral-impossible": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_queue_gone",
        "expired",
        "The email-sends queue was deleted, so there is nothing left to drain. I've stopped watching."
      )}
    />
  ),
  "wake-unverified": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_unverified",
        "expired",
        "The window ran out while I couldn't read the queue depth, so I can't tell you whether it drained. The last reading I do have was 42 pending, an hour ago."
      )}
    />
  ),

  "watches-live": <WatchChips watches={demoWatches.row.map(toWatchChip)} onCancel={noop} />,

  "banner-prod": (
    <DashboardAgentContextBanner
      projectSlug="demo-storefront"
      environmentSlug="prod"
      currentPage="Runs"
    />
  ),
  "banner-preview-long": (
    <DashboardAgentContextBanner
      projectSlug="demo-storefront"
      environmentSlug="preview-demo-feature-rework-receipt-email-batching"
      currentPage="Deployments"
    />
  ),
};

export default function Story() {
  return <GalleryPage page="chat" states={STATES} />;
}
