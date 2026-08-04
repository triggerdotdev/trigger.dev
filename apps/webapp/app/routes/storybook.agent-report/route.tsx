import type { ReportViewModelPayload } from "@internal/dashboard-agent-contracts";
import { demoFixtures, demoId } from "~/components/dashboard-agent/demo";
import { ReportView } from "~/components/dashboard-agent/ReportView";
import { chatItems } from "../storybook.agent-ui/fixtures";
import { fixtureResolveUri, GalleryPage, noop } from "../storybook.agent-ui/gallery";

/**
 * The health report, one state per verdict. The shell and the manifest live in
 * `../storybook.agent-ui`.
 */

// The report items of the demo conversations, for the source URI each card cites.
const reportItems = chatItems(demoId("report-healthy"), "report").concat(
  chatItems(demoId("report-degraded"), "report")
);

/**
 * The two demo VMs cover healthy and degraded; the third is derived here because
 * no fixture conversation shows it: when telemetry goes stale the interpreter
 * marks flow AND execution "unknown", strips every actionable field, and flags
 * the snapshot `trustworthy: false` — the one state where the card must show
 * numbers while refusing to advise on them. Derived exactly the way
 * `applyStaleGuard` does it, so the shape is real.
 */
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

const STATES: Record<string, React.ReactNode> = {
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
};

export default function Story() {
  return <GalleryPage page="report" states={STATES} />;
}
