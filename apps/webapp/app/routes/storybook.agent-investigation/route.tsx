import {
  INVESTIGATION_CAPABILITIES_VERSION,
  type InvestigationCapabilities,
} from "@internal/dashboard-agent-contracts";
import { demoFixtures } from "~/components/dashboard-agent/demo";
import { InvestigationCard } from "~/components/dashboard-agent/InvestigationCard";
import { investigationBlock } from "../storybook.agent-ui/fixtures";
import { fixtureResolveUri, GalleryPage, noop } from "../storybook.agent-ui/gallery";

const { demoInvestigations } = demoFixtures;

const citedUri = (
  fixture: (typeof demoInvestigations)[keyof typeof demoInvestigations],
  kind: string
) => fixture.evidence.find((evidence) => evidence.kind === kind)!.uri;

const codeGroundedCapabilities: InvestigationCapabilities = {
  version: INVESTIGATION_CAPABILITIES_VERSION,
  actions: [
    {
      kind: "show_code",
      label: "Show code",
      intent: {
        kind: "ask",
        prompt:
          "Show me the code behind this and propose the minimal fix as a fenced diff, anchored to the file, line and commit you read.",
      },
    },
    {
      kind: "view_similar",
      label: "View similar failures",
      intent: { kind: "navigate", target: citedUri(demoInvestigations.concluded, "error") },
    },
  ],
};

const notCodeGroundedCapabilities: InvestigationCapabilities = {
  version: INVESTIGATION_CAPABILITIES_VERSION,
  actions: [
    {
      kind: "view_similar",
      label: "View the queue",
      intent: { kind: "navigate", target: citedUri(demoInvestigations.concludedNoCode, "queue") },
    },
  ],
};

const STATES: Record<string, React.ReactNode> = {
  "investigation-card-streaming-rev1": (
    <InvestigationCard block={investigationBlock(demoInvestigations.streamingRev1)} />
  ),
  "investigation-card-concluded": (
    <InvestigationCard block={investigationBlock(demoInvestigations.concluded)} />
  ),
  "investigation-card-concluded-code-grounded": (
    <InvestigationCard
      block={investigationBlock(demoInvestigations.concluded, codeGroundedCapabilities)}
      resolveUri={fixtureResolveUri}
      onIntent={noop}
    />
  ),
  "investigation-card-concluded-not-code-grounded": (
    <InvestigationCard
      block={investigationBlock(demoInvestigations.concludedNoCode, notCodeGroundedCapabilities)}
      resolveUri={fixtureResolveUri}
      onIntent={noop}
    />
  ),
  "investigation-card-inconclusive": (
    <InvestigationCard
      block={investigationBlock(demoInvestigations.inconclusive)}
      defaultExpanded
      resolveUri={fixtureResolveUri}
    />
  ),
  "investigation-card-degraded": (
    <InvestigationCard
      block={investigationBlock(demoInvestigations.degraded)}
      defaultExpanded
      resolveUri={fixtureResolveUri}
    />
  ),
};

export default function Story() {
  return (
    <GalleryPage page="investigation" states={STATES} componentNames={["InvestigationCard.tsx"]} />
  );
}
