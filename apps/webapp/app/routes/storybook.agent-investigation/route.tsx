import {
  INVESTIGATION_CAPABILITIES_VERSION,
  type InvestigationCapabilities,
} from "@internal/dashboard-agent-contracts";
import { demoFixtures } from "~/components/dashboard-agent/demo";
import { InvestigationCard } from "~/components/dashboard-agent/InvestigationCard";
import { investigationBlock } from "../storybook.agent-ui/fixtures";
import { fixtureResolveUri, GalleryPage, noop } from "../storybook.agent-ui/gallery";

/**
 * The investigation card, one state per ending it can reach. The shell and the
 * manifest live in `../storybook.agent-ui`.
 *
 * The card only, so the unfinished state shows no progress line here: progress
 * belongs to the transcript, which mounts one line for the whole turn — see
 * `messages-investigation-live` on the Chat UI page.
 */

const { demoInvestigations } = demoFixtures;

/**
 * The actions the executor would attach to each settled card — written out here
 * because they are server-decided and the fixtures deliberately don't carry
 * them. "Show code" hangs on a source citation the agent read at the pinned
 * commit, which is exactly what separates the two concluded states below. Both
 * actions point at URIs the card already cites, the way the executor builds
 * them: an action can only ever target evidence the investigation resolved.
 */
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

// Nothing was read, so there is no code to show — only the follow-up that needs
// no source at all.
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
  return <GalleryPage page="investigation" states={STATES} />;
}
