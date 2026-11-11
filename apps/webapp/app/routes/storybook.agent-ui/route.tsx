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
import { cn } from "~/utils/cn";
import { demoTranscripts, investigationBlock, type DemoTranscript } from "./fixtures";
import { fixtureResolveUri, GalleryPage, noop, PANEL_FRAME } from "./gallery";

const { demoIntents, demoPageContexts, demoInvestigations } = demoFixtures;

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
                    projectName="Demo Storefront"
                    environmentSlug="prod"
                    entityId="run_a1b2c3d4e5f6"
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
  "intent-rejected-propose-fix": (
    <DemoIntentBubble intent={demoIntents.proposeFix} onIntercept={noop} />
  ),

  "banner-prod": (
    <DashboardAgentContextBanner
      projectName="Demo Storefront"
      environmentSlug="prod"
      entityId="run_a1b2c3d4e5f6"
    />
  ),
  "banner-preview-long": (
    <DashboardAgentContextBanner
      projectName="Demo Storefront"
      environmentSlug="preview-demo-feature-rework-receipt-email-batching"
      entityId="20240101.1"
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
