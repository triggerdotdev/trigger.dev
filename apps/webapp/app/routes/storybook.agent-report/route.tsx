import type { ReportViewModelPayload } from "@internal/dashboard-agent-contracts";
import { DEMO_WORLD, demoFixtures, demoReportUri } from "~/components/dashboard-agent/demo";
import { ReportView } from "~/components/dashboard-agent/ReportView";
import { fixtureResolveUri, GalleryPage, noop } from "../storybook.agent-ui/gallery";

const reportUri = demoReportUri(DEMO_WORLD.reportKey);

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
      reportUri={reportUri}
      onIntent={noop}
      resolveUri={fixtureResolveUri}
    />
  ),
  "report-view-degraded": (
    <ReportView
      vm={demoFixtures.demoDegradedReport}
      reportUri={reportUri}
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
