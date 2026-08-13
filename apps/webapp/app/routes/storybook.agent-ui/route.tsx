import type { UIMessage } from "@ai-sdk/react";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import { demoFixtures, DemoIntentBubble } from "~/components/dashboard-agent/demo";
import { ChatProgress, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { DashboardAgentComposer } from "~/components/dashboard-agent/DashboardAgentComposer";
import { DashboardAgentContextBanner } from "~/components/dashboard-agent/DashboardAgentContextBanner";
import { DashboardAgentHero } from "~/components/dashboard-agent/DashboardAgentHero";
import { DashboardAgentMessages } from "~/components/dashboard-agent/DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "~/components/dashboard-agent/DashboardAgentSuggestedPrompts";
import { AgentPanelColumn } from "~/components/dashboard-agent/panel-layout";
import { liveProgress } from "~/components/dashboard-agent/progress-line";
import type { WakeWatch } from "~/components/dashboard-agent/WakeBanner";
import { WatchChips, type WatchChip } from "~/components/dashboard-agent/WatchChips";
import { cn } from "~/utils/cn";
import { demoTranscripts, investigationBlock, type DemoTranscript } from "./fixtures";
import { fixtureResolveUri, GalleryPage, noop, PANEL_FRAME } from "./gallery";

const { demoIntents, demoWatches, demoPageContexts, demoInvestigations } = demoFixtures;

function MessageHarness({
  transcript,
  withError = false,
}: {
  transcript: DemoTranscript;
  withError?: boolean;
}) {
  return (
    <div className={PANEL_FRAME}>
      <DashboardAgentMessages
        messages={transcript.messages}
        activity={transcript.activity ?? null}
        error={withError && transcript.error ? new Error(transcript.error) : undefined}
        onRetry={withError ? noop : undefined}
        onDismissError={withError ? noop : undefined}
      />
    </div>
  );
}

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

const promotedPrompt: SuggestedPrompt = {
  id: "sp:promo-storybook",
  label: "Try the new health report",
  prompt: "Give me a health report for this environment.",
  source: "promoted",
};

// Resolver-minted ids: the panel resolves its own chips, so a demo-namespaced id would
// match nothing and the state would render undismissed.
const dismissedPromptIds = demoFixtures.demoResolvedDismissedPromptIds;

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

function wakeMessage(watchId: string, outcome: "fired" | "expired", text: string): UIMessage {
  return {
    id: `wake:watch:${watchId}:${outcome}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

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

function WakeHarness({ message, watches }: { message: UIMessage; watches?: WakeWatch[] }) {
  return (
    <div className={PANEL_FRAME}>
      <DashboardAgentMessages messages={[message]} activity={null} watches={watches} />
    </div>
  );
}

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

  "messages-streaming-text": <MessageHarness transcript={demoTranscripts.streamingText} />,
  "messages-reasoning": <MessageHarness transcript={demoTranscripts.reasoning} />,
  "messages-tool-in-flight": <MessageHarness transcript={demoTranscripts.toolInFlight} />,
  "messages-tool-pending-pills": <PendingPillsHarness />,
  "messages-error-retry": <MessageHarness transcript={demoTranscripts.errorRetry} withError />,
  "messages-render-view": <MessageHarness transcript={demoTranscripts.renderView} />,
  "messages-investigation-live": <LiveInvestigationHarness />,
  "messages-docs-sources": <MessageHarness transcript={demoTranscripts.docsSources} />,

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
  return (
    <GalleryPage
      page="chat"
      states={STATES}
      componentNames={[
        "DashboardAgentComposer.tsx",
        "DashboardAgentMessages.tsx",
        "DashboardAgentHero.tsx",
      ]}
    />
  );
}
