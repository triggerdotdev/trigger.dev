import type { UIMessage } from "@ai-sdk/react";
import type { DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent";
import {
  safeParseTriggerUri,
  VIEW_BLOCK_VERSION,
  type AgentPageContext,
  type InvestigationBlock,
  type ReportViewModelPayload,
  type SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import {
  demoChatById,
  demoFixtures,
  demoId,
  DemoChartCard,
  DemoIntentBubble,
  DemoInvestigationCard,
  DemoReportCard,
  DemoWatchChips,
  type DemoItem,
} from "~/components/dashboard-agent/demo";
import { DashboardAgentContextBanner } from "~/components/dashboard-agent/DashboardAgentContextBanner";
import { DashboardAgentMessages } from "~/components/dashboard-agent/DashboardAgentMessages";
import { DashboardAgentSuggestedPrompts } from "~/components/dashboard-agent/DashboardAgentSuggestedPrompts";
import { InvestigationCard } from "~/components/dashboard-agent/InvestigationCard";
import { ReportView } from "~/components/dashboard-agent/ReportView";
import { RunDiagnosisCard } from "~/components/dashboard-agent/RunDiagnosisCard";
import { resolveSuggestedPrompts } from "~/components/dashboard-agent/suggested-prompts";
import { ViewBlocks } from "~/components/dashboard-agent/view-catalog";
import type { WakeWatch } from "~/components/dashboard-agent/WakeBanner";
import { WatchChips, type WatchChip } from "~/components/dashboard-agent/WatchChips";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
import { GALLERY_GROUPS, MANIFEST, sectionsInGroup, type GallerySection } from "./manifest";

/**
 * The dashboard agent state gallery.
 *
 * Every state each panel component can be in, rendered in isolation at panel
 * width, fed by the demo fixtures in
 * `~/components/dashboard-agent/demo/fixtures` — the same data the demo
 * conversations use, so the gallery and the panel can never drift.
 *
 * `./manifest.ts` is the source of truth for what the page contains: sections
 * render in manifest order, and a manifest row with no renderer shows up as a
 * loud placeholder rather than silently vanishing. The screenshot script walks
 * the same manifest, capturing each section by its `id`.
 *
 * Gated by the parent `storybook` route, which requires an admin user.
 */

const noop = () => undefined;

/** Panel width, matching `DashboardAgent`'s default panel size. */
const PANEL = "w-[380px]";

// ---------------------------------------------------------------------------
// Diagnosis fixtures written for this page. The demo fixtures cover the cases
// the panel actually shows; these three cover the card's own range (a fully
// populated card, a thin one, and the middle) which no conversation needs.
// ---------------------------------------------------------------------------

const fullDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: "run_a1b2c3d4e5",
  summary:
    "The run failed because processOrder threw on an order with no line items. The payload had an empty items array.",
  category: "user_code_error",
  likelyCause:
    "processOrder calls order.items[0] without checking length, so an empty items array throws a TypeError before any work happens.",
  confidence: "high",
  evidence: [
    {
      type: "error",
      detail: "TypeError: Cannot read properties of undefined (reading 'sku')",
      reference: "run_a1b2c3d4e5",
    },
    { type: "failed_span", detail: "processOrder attempt 1 failed after 42ms" },
    {
      type: "source",
      detail: "The throwing line reads order.items[0].sku with no guard.",
      reference: "src/trigger/processOrder.ts:18",
    },
    {
      type: "historical_match",
      detail: "14 runs of this task hit the same error in the last 24h.",
      reference: "error_emptyorder",
    },
  ],
  impact:
    "14 runs of process-order failed with this error in the last 24 hours, all in production.",
  nextSteps: [
    "Guard against an empty items array at the top of processOrder and return early.",
    "Validate the payload before triggering so empty orders never reach the task.",
  ],
  actions: [
    { label: "View run", kind: "view_run", target: "run_a1b2c3d4e5" },
    { label: "Retries docs", kind: "docs", target: "https://trigger.dev/docs/errors-retrying" },
  ],
};

const externalServiceDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: "run_f6g7h8i9j0",
  summary: "chargePayment timed out waiting on the Stripe API after 30 seconds.",
  category: "external_service",
  likelyCause:
    "The Stripe call has no timeout or retry, so a slow upstream response runs past the task's max duration.",
  confidence: "medium",
  evidence: [
    {
      type: "error",
      detail: "TimeoutError: Stripe API timed out after 30s",
      reference: "run_f6g7h8i9j0",
    },
    { type: "deploy", detail: "First seen on version 20260620.2", reference: "20260620.2" },
  ],
  impact: "Intermittent: 3 of the last 50 charge-payment runs timed out.",
  nextSteps: [
    "Wrap the Stripe call in a retry with backoff.",
    "Set an explicit request timeout shorter than the task's max duration.",
  ],
  actions: [{ label: "View run", kind: "view_run", target: "run_f6g7h8i9j0" }],
};

const lowConfidenceDiagnosis: DiagnosisBlock = {
  type: "diagnosis",
  runId: "run_k1l2m3n4o5",
  summary:
    "The run crashed without a captured error, so the cause isn't conclusive from the available signals.",
  category: "unknown",
  likelyCause:
    "The container exited without writing an error. This is consistent with an out-of-memory kill, but there's no OOM signal in the trace to confirm it.",
  confidence: "low",
  evidence: [
    { type: "failed_span", detail: "Root span ended with status CRASHED and no error payload." },
    { type: "logs", detail: "Logs stop abruptly mid-execution with no stack trace." },
  ],
  nextSteps: [
    "Re-run with a larger machine to rule out out-of-memory.",
    "Add logging around the last successful step to narrow where it stops.",
  ],
};

// Blocks may carry an envelope: `id` identifies the block across turns and
// `revision` says how fresh it is. ViewBlocks collapses same-(type, id) blocks
// to the highest revision, so a re-emitted diagnosis replaces the earlier one
// instead of stacking cards.
const revisedDiagnosis: ViewBlock[] = [
  {
    ...lowConfidenceDiagnosis,
    id: "diagnosis-run_a1b2c3d4e5",
    revision: 1,
    version: VIEW_BLOCK_VERSION,
    summary: "Revision 1 — first guess, before the logs came back. Should not render.",
  },
  {
    ...externalServiceDiagnosis,
    id: "diagnosis-run_a1b2c3d4e5",
    revision: 2,
    version: VIEW_BLOCK_VERSION,
    summary: "Revision 2 — narrowed to the payload, still unconfirmed. Should not render.",
  },
  {
    ...fullDiagnosis,
    id: "diagnosis-run_a1b2c3d4e5",
    revision: 3,
    version: VIEW_BLOCK_VERSION,
    summary:
      "Revision 3 — the only card that should render: processOrder threw on an order with no line items.",
  },
];

// Two envelope-less (legacy) blocks: no id, so nothing is grouped and both
// render, in order — the pre-envelope behaviour.
const legacyBlocks: ViewBlock[] = [externalServiceDiagnosis, lowConfidenceDiagnosis];

/**
 * The badge matrix: one card per diagnosis category, cycling through the three
 * confidence levels, so every badge colour pair on the card is on screen at
 * once and can be checked in both themes. Bodies are the demo fixture's, so the
 * only thing varying is the badges.
 */
const DIAGNOSIS_CATEGORIES: DiagnosisBlock["category"][] = [
  "user_code_error",
  "configuration",
  "dependency",
  "timeout",
  "out_of_memory",
  "rate_limit",
  "external_service",
  "infrastructure",
  "cancellation",
  "unknown",
];

const CONFIDENCES: DiagnosisBlock["confidence"][] = ["high", "medium", "low"];

const badgeMatrixBlocks: DiagnosisBlock[] = DIAGNOSIS_CATEGORIES.map((category, i) => ({
  ...demoFixtures.demoDiagnosisBlockFirstPass,
  category,
  confidence: CONFIDENCES[i % CONFIDENCES.length]!,
  // The badges are the subject; strip everything that would make each card tall.
  evidence: [],
  nextSteps: [],
  actions: undefined,
  impact: undefined,
}));

// ---------------------------------------------------------------------------
// Reading fixture conversations. The message-level states already exist as demo
// chats, so the harness pulls their items rather than inventing transcripts.
// ---------------------------------------------------------------------------

function chatItems<K extends DemoItem["kind"]>(
  chatId: string,
  kind: K
): Extract<DemoItem, { kind: K }>[] {
  const chat = demoChatById(chatId);
  return (chat?.items ?? []).filter(
    (item): item is Extract<DemoItem, { kind: K }> => item.kind === kind
  );
}

function chatMessages(chatId: string, take?: number): UIMessage[] {
  const items = chatItems(chatId, "messages");
  return (take === undefined ? items : items.slice(0, take)).flatMap((item) => item.messages);
}

/**
 * `DashboardAgentMessages` in isolation. Its root is `flex-1 overflow-y-auto`,
 * which in a plain block parent resolves to content height with nothing to
 * scroll — so the whole transcript is visible and screenshotable.
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
    <div className="rounded-lg border border-grid-bright bg-background-bright">
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
 * Every pending pill next to each other, one turn per in-flight tool.
 *
 * A real turn only ever has one call in flight, so this is a label sheet rather
 * than a transcript: the phrasing has to hold up read as a set, and the two tools
 * that used to stream the most input JSON before flipping to a card (`render_view`,
 * `get_report`) have to look like every other wait. The last one is a tool the
 * label map doesn't know, showing the `Running <name>` fallback.
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
  const messages: UIMessage[] = PENDING_PILL_TOOLS.map(({ tool, input }) =>
    demoFixtures.assistantMessage(`pending-${tool}`, [
      demoFixtures.pendingToolPart(tool, input, `pending-${tool}`),
    ])
  );
  return (
    <div className="rounded-lg border border-grid-bright bg-background-bright">
      <DashboardAgentMessages messages={messages} activity={null} />
    </div>
  );
}

/** The demo chart card's frame around an empty result set. */
function EmptyChartCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="border-b border-grid-bright bg-background-bright px-3 py-2 text-xs font-medium text-text-dimmed">
        {demoFixtures.demoChart.title}
      </div>
      <div className="h-64 w-full p-2">
        <QueryResultsChart
          rows={[]}
          columns={demoFixtures.demoChart.columns}
          config={demoFixtures.demoChart.config}
          timeRange={demoFixtures.demoChart.timeRange}
        />
      </div>
    </div>
  );
}

/**
 * The real `DashboardAgentSuggestedPrompts`, fed a fixture page context.
 *
 * The chips come from the registry resolver, so what's on screen here is exactly
 * what the panel shows on that page — including the ordering and the cap.
 * `dismissedIds` is passed explicitly, which puts the component in its controlled
 * mode so the gallery never touches (or is affected by) localStorage.
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
      <div className="rounded-lg border border-grid-bright bg-background-bright py-4">
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

function Missing({ what }: { what: string }) {
  return (
    <div className="rounded-md border border-error/50 bg-error/10 px-3 py-2 text-xs text-error">
      No renderer for {what}. The manifest and the gallery are out of sync.
    </div>
  );
}

// ---------------------------------------------------------------------------
// The state map. Keyed by `sectionId`, so the manifest drives what renders.
// ---------------------------------------------------------------------------

const { demoInvestigations, demoIntents, demoWatches, demoPageContexts } = demoFixtures;

// A stand-in for whatever the `promotedDashboardAgentPrompt` flag holds in
// production — the point of the state is the styling of the top slot.
const promotedPrompt: SuggestedPrompt = {
  id: "sp:promo-storybook",
  label: "Try the new health report",
  prompt: "Give me a health report for this environment.",
  source: "promoted",
};

// Dismiss whatever the resolver puts first on the failed-run page, so the
// "after a dismissal" state always shows a real chip having been removed even if
// the registry's wording changes.
const dismissedPromptIds = resolveSuggestedPrompts(demoPageContexts.failedRun)
  .slice(0, 1)
  .map((prompt) => prompt.id);

const reportItems = chatItems(demoId("report-healthy"), "report").concat(
  chatItems(demoId("report-degraded"), "report")
);

// ---------------------------------------------------------------------------
// Report fixtures for the shipped ReportView. The two demo VMs cover healthy and
// degraded; the third is derived here because no fixture conversation shows it:
// when telemetry goes stale the interpreter marks flow AND execution "unknown",
// strips every actionable field, and flags the snapshot `trustworthy: false` —
// the one state where the card must show numbers while refusing to advise on
// them. Derived exactly the way `applyStaleGuard` does it, so the shape is real.
// ---------------------------------------------------------------------------

const untrustworthyReport: ReportViewModelPayload = {
  ...demoFixtures.demoDegradedReport,
  summary: {
    severity: "crit",
    statements: [
      { findingType: "flow", severity: "crit", reason: "unknown" },
      { findingType: "execution", severity: "crit", reason: "unknown" },
      { findingType: "liveness", severity: "crit" },
    ],
  },
  findings: demoFixtures.demoDegradedReport.findings.map((finding) =>
    finding.type === "liveness"
      ? {
          ...finding,
          severity: "crit",
          reason: "stale",
          recommendation: { code: "check_control_plane", link: "status" },
        }
      : {
          ...finding,
          severity: "crit",
          reason: "unknown",
          recommendation: undefined,
          attribution: undefined,
          exclusions: undefined,
          observations: undefined,
          hedge: undefined,
          anomalyWindow: undefined,
        }
  ),
  metrics: demoFixtures.demoDegradedReport.metrics.map((metric) =>
    metric.id === "liveness"
      ? { ...metric, value: 21 * 60_000, severity: "crit" }
      : { ...metric, annotation: undefined }
  ),
  facts: { trustworthy: false, staleReason: "telemetry_stale" },
  links: [{ key: "status", label: "status.trigger.dev", url: "https://status.trigger.dev" }],
  footer: [{ code: "check_control_plane", link: "status" }],
};

/**
 * The gallery's stand-in for the panel's URI resolver. In the app the host
 * resolves against the real environment (`resolveTriggerUri.server.ts`); here a
 * fixture resolver proves the seam exists without a project route.
 */
/**
 * The demo investigation fixtures, as the real `investigation` block: the demo
 * type carries its identity inline (`investigationId` + `revision`) where the
 * block carries it in the envelope, so the mapping is a move, not a rewrite —
 * which is the point of having reviewed the demo payload.
 */
function investigationBlock(
  fixture: (typeof demoInvestigations)[keyof typeof demoInvestigations]
): InvestigationBlock {
  const { investigationId, revision, ...investigation } = fixture;
  return {
    type: "investigation",
    id: investigationId,
    revision,
    version: VIEW_BLOCK_VERSION,
    investigation,
  };
}

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

// ---------------------------------------------------------------------------
// Wake fixtures, written here rather than pulled from the demo conversations: a
// wake is a message *id* plus the watch it names, and no demo chat carries one.
// ---------------------------------------------------------------------------

/** A wake narration, in the shape the panel merges live stream and history into. */
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
    identity: "health_recovery:",
  },
  {
    id: "watch_error",
    kind: "error_recurrence",
    note: "tell me if that TypeError comes back",
    identity: "error_recurrence:a1b2c3d4e5f6",
  },
  {
    id: "watch_run",
    kind: "run_finished",
    note: "ping me when the nightly backfill finishes",
    identity: "run_finished:run_a1b2c3d4e5",
  },
];

/** One wake through the production renderer, with the watches the panel would have. */
function WakeHarness({ message, watches }: { message: UIMessage; watches?: WakeWatch[] }) {
  return (
    <div className="rounded-lg border border-grid-bright bg-background-bright">
      <DashboardAgentMessages messages={[message]} activity={null} watches={watches} />
    </div>
  );
}

function fixtureResolveUri(uri: string): { label: string; url: string } | null {
  const parsed = safeParseTriggerUri(uri);
  if (!parsed.success) return null;
  return { label: uri.split("/").slice(-1)[0]!, url: "#resolved-by-the-host" };
}

const STATES: Record<string, React.ReactNode> = {
  // --- Diagnosis card -----------------------------------------------------
  "diagnosis-full-high": <RunDiagnosisCard block={fullDiagnosis} />,
  "diagnosis-external-medium": <RunDiagnosisCard block={externalServiceDiagnosis} />,
  "diagnosis-low-minimal": <RunDiagnosisCard block={lowConfidenceDiagnosis} />,
  "diagnosis-demo-first-pass": (
    <RunDiagnosisCard block={demoFixtures.demoDiagnosisBlockFirstPass} />
  ),
  "diagnosis-demo-revised": <RunDiagnosisCard block={demoFixtures.demoDiagnosisBlockRevised} />,
  "diagnosis-badge-matrix": (
    <div className="flex flex-wrap gap-3">
      {badgeMatrixBlocks.map((block, i) => (
        <div key={i} className="w-[300px]">
          <RunDiagnosisCard block={block} />
        </div>
      ))}
    </div>
  ),

  // --- ViewBlocks ---------------------------------------------------------
  "view-blocks-revisions": <ViewBlocks blocks={revisedDiagnosis} />,
  "view-blocks-legacy": <ViewBlocks blocks={legacyBlocks} />,
  "view-blocks-mixed": (
    <ViewBlocks
      blocks={[
        demoFixtures.demoDiagnosisBlockFirstPass,
        demoFixtures.demoDiagnosisBlockRevised,
        demoFixtures.demoLegacyDiagnosisBlock,
      ]}
    />
  ),

  // --- Investigation card, the shipped one ---------------------------------
  "investigation-card-streaming-rev0": (
    <InvestigationCard block={investigationBlock(demoInvestigations.streamingRev0)} />
  ),
  "investigation-card-streaming-rev1": (
    <InvestigationCard block={investigationBlock(demoInvestigations.streamingRev1)} />
  ),
  "investigation-card-concluded": (
    <InvestigationCard block={investigationBlock(demoInvestigations.concluded)} />
  ),
  "investigation-card-concluded-expanded": (
    <InvestigationCard
      block={investigationBlock(demoInvestigations.concluded)}
      defaultExpanded
      resolveUri={fixtureResolveUri}
    />
  ),
  "investigation-card-inconclusive": (
    <InvestigationCard
      block={investigationBlock(demoInvestigations.inconclusive)}
      defaultExpanded
      resolveUri={fixtureResolveUri}
    />
  ),
  "investigation-card-dirty-commit": (
    <InvestigationCard block={investigationBlock(demoInvestigations.dirtyCommit)} />
  ),
  // Through the production renderer: two revisions of one investigation reach
  // the panel and latest-wins leaves a single, current card.
  "investigation-card-revisions": (
    <ViewBlocks
      blocks={[
        investigationBlock(demoInvestigations.streamingRev0),
        investigationBlock(demoInvestigations.streamingRev1),
      ]}
      resolveUri={fixtureResolveUri}
    />
  ),

  // --- Investigation card, the reviewed demo mockup ------------------------
  "investigation-streaming-rev0": (
    <DemoInvestigationCard investigation={demoInvestigations.streamingRev0} />
  ),
  "investigation-streaming-rev1": (
    <DemoInvestigationCard investigation={demoInvestigations.streamingRev1} />
  ),
  "investigation-concluded": <DemoInvestigationCard investigation={demoInvestigations.concluded} />,
  "investigation-concluded-expanded": (
    <DemoInvestigationCard investigation={demoInvestigations.concluded} defaultExpanded />
  ),
  "investigation-inconclusive": (
    <DemoInvestigationCard investigation={demoInvestigations.inconclusive} defaultExpanded />
  ),
  "investigation-dirty-commit": (
    <DemoInvestigationCard investigation={demoInvestigations.dirtyCommit} />
  ),

  // --- Report card --------------------------------------------------------
  "report-view-healthy": (
    <ReportView
      vm={demoFixtures.demoHealthyReport}
      reportUri={reportItems[0]?.sourceUri}
      onIntent={noop}
      resolveUri={fixtureResolveUri}
    />
  ),
  "report-view-degraded": (
    <ReportView
      vm={demoFixtures.demoDegradedReport}
      reportUri={reportItems[1]?.sourceUri}
      onIntent={noop}
      resolveUri={fixtureResolveUri}
    />
  ),
  "report-view-untrustworthy": (
    <ReportView vm={untrustworthyReport} onIntent={noop} resolveUri={fixtureResolveUri} />
  ),
  "report-healthy": (
    <DemoReportCard
      vm={demoFixtures.demoHealthyReport}
      sourceUri={reportItems[0]?.sourceUri}
      onAction={noop}
    />
  ),
  "report-degraded": (
    <DemoReportCard
      vm={demoFixtures.demoDegradedReport}
      sourceUri={reportItems[1]?.sourceUri}
      onAction={noop}
    />
  ),

  // --- Chart card ---------------------------------------------------------
  "chart-with-data": <DemoChartCard />,
  "chart-empty": <EmptyChartCard />,

  // --- Watch chips --------------------------------------------------------
  "watches-active": <DemoWatchChips watches={[demoWatches.runFinished]} onCancel={noop} />,
  "watches-fired": <DemoWatchChips watches={[demoWatches.errorRecurrence]} />,
  "watches-expired": <DemoWatchChips watches={[demoWatches.healthRecovery]} />,
  "watches-cancelled": <DemoWatchChips watches={[demoWatches.cancelled]} />,
  "watches-all-states": <DemoWatchChips watches={demoWatches.row} onCancel={noop} />,
  // The real panel component, fed the same fixtures through the shape its loader
  // hands over — so its labels (derived from the watch identity) and the demo
  // chips above can be compared side by side.
  "watches-live": <WatchChips watches={demoWatches.row.map(toWatchChip)} onCancel={noop} />,

  // --- Wake banners -------------------------------------------------------
  "wake-fired-good-news": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_health",
        "fired",
        "Production is back to normal: the failure rate has been under 1% for the last 15 minutes and the queue has drained. Nothing left for me to watch here."
      )}
    />
  ),
  "wake-fired-attention": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_error",
        "fired",
        "That TypeError is back — 6 runs of process-order failed with it in the last 10 minutes, all on version 20260620.2. Same empty-items payload as before."
      )}
    />
  ),
  "wake-expired": (
    <WakeHarness
      watches={wakeWatches}
      message={wakeMessage(
        "watch_run",
        "expired",
        "I stopped watching the nightly backfill: it still hasn't finished, and the watch has run out. Ask me again if you want me to keep an eye on it."
      )}
    />
  ),
  // No watches in hand (an older chat, or a watch already swept away): the
  // banner still fires, without claiming an outcome it can't know.
  "wake-unknown-watch": (
    <WakeHarness
      message={wakeMessage(
        "watch_gone",
        "fired",
        "The condition you asked me to watch for just happened. Here's what the check found."
      )}
    />
  ),

  // --- Suggested prompts --------------------------------------------------
  // The real component, resolving the registry against each fixture context.
  "prompts-default": <PromptsHarness context={demoPageContexts.other} />,
  "prompts-contextual-fresh-failure": <PromptsHarness context={demoPageContexts.failedRun} />,
  "prompts-promoted": (
    <PromptsHarness context={demoPageContexts.failedRun} promoted={promotedPrompt} />
  ),
  "prompts-dismissed": (
    <PromptsHarness context={demoPageContexts.failedRun} dismissedIds={dismissedPromptIds} />
  ),
  "prompts-contextual-waiting-run": <PromptsHarness context={demoPageContexts.waitingRun} />,
  "prompts-contextual-slow-run": <PromptsHarness context={demoPageContexts.slowRun} />,
  "prompts-contextual-saturation": <PromptsHarness context={demoPageContexts.queue} />,
  "prompts-page-runs": <PromptsHarness context={demoPageContexts.runs} />,
  "prompts-page-error": <PromptsHarness context={demoPageContexts.error} />,
  "prompts-page-deployment": <PromptsHarness context={demoPageContexts.deployment} />,

  // --- Intent bubbles -----------------------------------------------------
  "intent-navigate-filtered-runs": (
    <DemoIntentBubble intent={demoIntents.navigateToFailedRuns} onIntercept={noop} />
  ),
  "intent-navigate-run": <DemoIntentBubble intent={demoIntents.navigateToRun} onIntercept={noop} />,
  "intent-watch": <DemoIntentBubble intent={demoIntents.watch} onIntercept={noop} />,
  "intent-ask": <DemoIntentBubble intent={demoIntents.ask} onIntercept={noop} />,
  "intent-rejected-propose-fix": (
    <DemoIntentBubble intent={demoIntents.proposeFix} onIntercept={noop} />
  ),

  // --- Message-level states ------------------------------------------------
  "messages-streaming-text": <MessageHarness chatId={demoId("base-streaming")} />,
  "messages-reasoning": <MessageHarness chatId={demoId("investigate-streaming")} />,
  "messages-tool-in-flight": <MessageHarness chatId={demoId("base-tool-in-flight")} />,
  "messages-tool-pending-pills": <PendingPillsHarness />,
  "messages-tool-expanded": <MessageHarness chatId={demoId("base-tool-in-flight")} />,
  "messages-error-retry": <MessageHarness chatId={demoId("base-error-retry")} withError />,
  // Two turns only: the resumed chat's third turn is a live `chart` block, and
  // the real AgentChart has no environment to query outside a project route.
  "messages-render-view": <MessageHarness chatId={demoId("base-resumed")} take={2} />,
  "messages-docs-sources": <MessageHarness chatId={demoId("docs-answer")} />,

  // --- Context banner (variants live here, not in demo chats) --------------
  "banner-prod": (
    <DashboardAgentContextBanner
      projectSlug="demo-storefront"
      environmentSlug="prod"
      currentPage="Runs"
    />
  ),
  "banner-dev": (
    <DashboardAgentContextBanner
      projectSlug="demo-storefront"
      environmentSlug="dev"
      currentPage="Queues"
    />
  ),
  "banner-preview-long": (
    <DashboardAgentContextBanner
      projectSlug="demo-storefront"
      environmentSlug="preview-demo-feature-rework-receipt-email-batching"
      currentPage="Deployments"
    />
  ),
  "banner-run-detail": (
    <DashboardAgentContextBanner
      projectSlug="demo-storefront"
      environmentSlug="prod"
      currentPage="Run detail"
    />
  ),
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * One state. The `id` is the deep-link anchor and the screenshot target, and the
 * element is width-fitted so a capture of it hugs the component instead of the
 * page.
 */
function Section({ section, wide = false }: { section: GallerySection; wide?: boolean }) {
  const state = STATES[section.sectionId];
  return (
    <section id={section.sectionId} className="w-fit scroll-mt-4 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-text-bright">{section.title}</h3>
        <code className="font-mono text-[10px] text-text-faint">{section.sectionId}</code>
      </div>
      <div className={cn(wide ? "w-auto" : PANEL)}>
        {state ?? <Missing what={`section "${section.sectionId}"`} />}
      </div>
    </section>
  );
}

/** Groups whose states are wider than the panel. */
const WIDE_SECTIONS = new Set(["diagnosis-badge-matrix"]);

function ThemeToggle() {
  return (
    <div className="flex items-center gap-1.5">
      {(["dark", "light"] as const).map((theme) => (
        <button
          key={theme}
          type="button"
          onClick={() => document.documentElement.setAttribute("data-theme", theme)}
          className="rounded border border-border-bright bg-background-bright px-2 py-1 text-xs text-text-dimmed transition hover:text-text-bright"
        >
          {theme}
        </button>
      ))}
    </div>
  );
}

function Nav() {
  return (
    <nav className="sticky top-0 space-y-3 self-start py-6 pr-4">
      {GALLERY_GROUPS.map(({ group, label }) => (
        <div key={group} className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-text-faint">{label}</p>
          <ul className="space-y-0.5">
            {sectionsInGroup(group).map((section) => (
              <li key={section.sectionId}>
                <a
                  href={`#${section.sectionId}`}
                  className="block truncate text-xs text-text-dimmed transition hover:text-text-bright"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function Story() {
  return (
    <div className="grid grid-cols-[15rem_1fr] gap-4 px-6">
      <Nav />

      <div className="flex flex-col gap-10 py-6">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-4">
            <Header1>Dashboard agent UI</Header1>
            <ThemeToggle />
          </div>
          <Paragraph variant="small">
            Every state the agent panel's components can be in, rendered in isolation at panel width
            (380px) from the demo fixtures in{" "}
            <code className="font-mono text-xs">app/components/dashboard-agent/demo/fixtures</code>{" "}
            — the same data the demo conversations use. {MANIFEST.length} states across{" "}
            {GALLERY_GROUPS.length} groups; the list lives in{" "}
            <code className="font-mono text-xs">manifest.ts</code>, which the screenshot script
            walks too.
          </Paragraph>
          <Paragraph variant="extra-small">
            Run ids, queues, errors and reports are fabricated. Deep links resolve inside a project,
            so here they render as plain text or navigate nowhere. The theme buttons flip{" "}
            <code className="font-mono text-xs">data-theme</code> on the root element, which is how
            the screenshot pack captures both themes.
          </Paragraph>
        </div>

        {GALLERY_GROUPS.map(({ group, label }) => (
          <div key={group} className="flex flex-col gap-4">
            <Header2 className="border-b border-grid-bright pb-1">{label}</Header2>
            <div className="flex flex-wrap items-start gap-8">
              {sectionsInGroup(group).map((section) => (
                <Section
                  key={section.sectionId}
                  section={section}
                  wide={WIDE_SECTIONS.has(section.sectionId)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
