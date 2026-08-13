import { DEMO_WORLD, demoFixtures, demoReportUri } from "~/components/dashboard-agent/demo";
import { ReportView } from "~/components/dashboard-agent/ReportView";
import { untrustworthyReport } from "../storybook.agent-ui/fixtures";
import { fixtureResolveUri, GalleryPage, noop } from "../storybook.agent-ui/gallery";

const reportUri = demoReportUri(DEMO_WORLD.reportKey);

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
  return <GalleryPage page="report" states={STATES} componentNames={["ReportView.tsx"]} />;
}
