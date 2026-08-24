import type { DiagnosisBlock } from "@internal/dashboard-agent";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { AGENT_CHART_PLOT_CLASS } from "~/components/dashboard-agent/AgentChart";
import { ConfidenceBadge } from "~/components/dashboard-agent/agent-badges";
import {
  AgentCard,
  AgentCardBody,
  AgentCardHeader,
  type AgentCardDensity,
} from "~/components/dashboard-agent/agent-card";
import { DemoChartCard, demoFixtures } from "~/components/dashboard-agent/demo";
import { RunDiagnosisCard } from "~/components/dashboard-agent/RunDiagnosisCard";
import { ViewBlocks } from "~/components/dashboard-agent/view-catalog";
import {
  fullDiagnosis,
  lowConfidenceDiagnosis,
  offerActionsBlock,
  revisedDiagnosisBlocks,
} from "../storybook.agent-ui/fixtures";
import { GalleryPage, noop } from "../storybook.agent-ui/gallery";

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
    <AgentCard>
      <AgentCardHeader className="text-xs font-medium text-text-dimmed">
        {demoFixtures.demoChart.title}
      </AgentCardHeader>
      <div className={AGENT_CHART_PLOT_CLASS}>
        <QueryResultsChart
          rows={[]}
          columns={demoFixtures.demoChart.columns}
          config={demoFixtures.demoChart.config}
          timeRange={demoFixtures.demoChart.timeRange}
        />
      </div>
    </AgentCard>
  );
}

/** The card primitive on its own: both body densities, and a card with no header. */
function CardChrome({ density, header }: { density?: AgentCardDensity; header?: boolean }) {
  return (
    <AgentCard>
      {header ? (
        <AgentCardHeader className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-text-dimmed">Card header</span>
          <ConfidenceBadge confidence="high" />
        </AgentCardHeader>
      ) : null}
      <AgentCardBody density={density}>
        <p className="text-sm text-text-bright">
          The card owns its border, surface and insets; the transcript owns where it sits.
        </p>
        <p className="text-sm text-text-dimmed">
          A second section, so the body's density is visible as the gap between them.
        </p>
      </AgentCardBody>
    </AgentCard>
  );
}

const STATES: Record<string, React.ReactNode> = {
  "view-blocks-revisions": <ViewBlocks blocks={revisedDiagnosisBlocks} />,
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

  "card-compact": <CardChrome header density="compact" />,
  "card-roomy": <CardChrome header density="roomy" />,
  "card-headerless": <CardChrome />,

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
  return (
    <GalleryPage
      page="view-blocks"
      states={STATES}
      componentNames={["AgentChart.tsx", "RunDiagnosisCard.tsx", "agent-card.tsx"]}
    />
  );
}
