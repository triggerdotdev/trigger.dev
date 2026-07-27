import type { UIMessage } from "@ai-sdk/react";
import type { DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent";
import { VIEW_BLOCK_VERSION } from "@internal/dashboard-agent-contracts";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import {
  demoChatById,
  demoFixtures,
  demoId,
  DemoChartCard,
  DemoIntentBubble,
  DemoInvestigationCard,
  DemoReportCard,
  DemoSuggestedPromptsRow,
  DemoWatchChips,
  type DemoItem,
} from "~/components/dashboard-agent/demo";
import { DashboardAgentMessages } from "~/components/dashboard-agent/DashboardAgentMessages";
import { RunDiagnosisCard } from "~/components/dashboard-agent/RunDiagnosisCard";
import { ViewBlocks } from "~/components/dashboard-agent/view-catalog";
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

const { demoInvestigations, demoIntents, demoPrompts, demoWatches, demoPageContexts } =
  demoFixtures;

const reportItems = chatItems(demoId("report-healthy"), "report").concat(
  chatItems(demoId("report-degraded"), "report")
);

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

  // --- Investigation card -------------------------------------------------
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

  // --- Suggested prompts --------------------------------------------------
  "prompts-default": <DemoSuggestedPromptsRow prompts={demoPrompts.defaults} onSelect={noop} />,
  "prompts-contextual-fresh-failure": (
    <DemoSuggestedPromptsRow
      prompts={demoPrompts.sets.failedRun}
      context={demoPageContexts.failedRun}
      onSelect={noop}
      onDismiss={noop}
    />
  ),
  "prompts-promoted": (
    <DemoSuggestedPromptsRow prompts={demoPrompts.sets.failedRun.slice(0, 1)} onSelect={noop} />
  ),
  "prompts-dismissed": (
    <DemoSuggestedPromptsRow
      prompts={demoPrompts.sets.failedRun}
      context={demoPageContexts.failedRun}
      dismissedIds={demoPrompts.dismissedIds}
      onSelect={noop}
      onDismiss={noop}
    />
  ),

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
  "messages-tool-expanded": <MessageHarness chatId={demoId("base-tool-in-flight")} />,
  "messages-error-retry": <MessageHarness chatId={demoId("base-error-retry")} withError />,
  // Two turns only: the resumed chat's third turn is a live `chart` block, and
  // the real AgentChart has no environment to query outside a project route.
  "messages-render-view": <MessageHarness chatId={demoId("base-resumed")} take={2} />,
  "messages-docs-sources": <MessageHarness chatId={demoId("docs-answer")} />,
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
