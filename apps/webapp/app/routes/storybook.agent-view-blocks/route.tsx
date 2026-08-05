import type { DiagnosisBlock, ViewBlock } from "@internal/dashboard-agent";
import { VIEW_BLOCK_VERSION } from "@internal/dashboard-agent-contracts";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { AGENT_CHART_PLOT_CLASS } from "~/components/dashboard-agent/AgentChart";
import { DemoChartCard, demoFixtures } from "~/components/dashboard-agent/demo";
import { RunDiagnosisCard } from "~/components/dashboard-agent/RunDiagnosisCard";
import { ViewBlocks } from "~/components/dashboard-agent/view-catalog";
import { GalleryPage, noop } from "../storybook.agent-ui/gallery";

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

const offerActionsBlock: ViewBlock = {
  type: "actions",
  id: "actions-offer",
  revision: 0,
  version: VIEW_BLOCK_VERSION,
  actions: [
    {
      label: "Set up a watch",
      intent: {
        kind: "watch",
        spec: {
          kind: "error_recurrence",
          fingerprint: "a1b2c3",
          checkEveryMinutes: 15,
          maxHours: 6,
          note: "the TypeError in send-order-receipt",
        },
      },
    },
    {
      label: "See its failed runs",
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/runs" },
    },
  ],
};

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
  evidence: [],
  nextSteps: [],
  actions: undefined,
  impact: undefined,
}));

function EmptyChartCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="border-b border-grid-bright bg-background-bright px-3 py-2 text-xs font-medium text-text-dimmed">
        {demoFixtures.demoChart.title}
      </div>
      <div className={AGENT_CHART_PLOT_CLASS}>
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

const STATES: Record<string, React.ReactNode> = {
  "view-blocks-revisions": <ViewBlocks blocks={revisedDiagnosis} />,
  "view-blocks-mixed": (
    <ViewBlocks
      blocks={[
        demoFixtures.demoDiagnosisBlockFirstPass,
        demoFixtures.demoDiagnosisBlockRevised,
        demoFixtures.demoLegacyDiagnosisBlock,
      ]}
    />
  ),
  "view-blocks-actions-offer": <ViewBlocks blocks={[offerActionsBlock]} onIntent={noop} />,

  "diagnosis-full-high": <RunDiagnosisCard block={fullDiagnosis} />,
  "diagnosis-low-minimal": <RunDiagnosisCard block={lowConfidenceDiagnosis} />,
  "diagnosis-badge-matrix": (
    <div className="flex flex-wrap gap-3">
      {badgeMatrixBlocks.map((block, i) => (
        <div key={i} className="w-[300px]">
          <RunDiagnosisCard block={block} />
        </div>
      ))}
    </div>
  ),

  "chart-with-actions": (
    <DemoChartCard actions={demoFixtures.demoChartBlock.actions ?? []} onIntent={noop} />
  ),
  "chart-empty": <EmptyChartCard />,
};

export default function Story() {
  return <GalleryPage page="view-blocks" states={STATES} />;
}
