import type { AgentIntent, ViewBlock } from "@internal/dashboard-agent-contracts";
import { AgentChart } from "./AgentChart";
import { InvestigationCard } from "./InvestigationCard";
import { ReportView, type ResolvedUri } from "./ReportView";
import { RunDiagnosisCard } from "./RunDiagnosisCard";
import { blockKey, latestRevisionBlocks } from "./view-blocks";

// The render registry for the dashboard agent's view catalog — our small
// "generative UI" layer. The agent emits a `render_view` tool call whose output
// is `{ blocks: ViewBlock[] }` (a spec drawn from the catalog defined in
// internal-packages/dashboard-agent). Here we map each block `type` to its
// component. Unknown types are skipped, so an older/newer agent can never
// render arbitrary content — same guarantee a generative-UI framework gives,
// without the dependency. Add a block by adding a `case` here and a union
// member in the package's `viewBlockSchema`.
//
// Blocks may carry an envelope (`id` + `revision`): those are keyed by identity
// and collapsed latest-wins, so a re-emitted block replaces its earlier
// revision instead of stacking a second card. Blocks without one render as
// before, keyed by index. See `view-blocks.ts`.
//
// Two ways a card reaches the user, both ending here: `render_view` blocks the
// model composed, and blocks the host synthesises from a tool result (a `report`
// is built from the completed `get_report` call — see `report-block-adapter.ts`).
export function ViewBlocks({
  blocks,
  /**
   * Where a card's actions go. Cards never navigate or ask on their own — they
   * emit an intent and the host honours it (or doesn't). Optional: without it,
   * intent-only actions render as plain text rather than dead buttons.
   */
  onIntent,
  /**
   * Host resolver for `trigger://` URIs cited by a card. Only the host knows the
   * environment the URI should resolve against; see `resolveTriggerUri.server.ts`
   * for the server-side mapping.
   */
  resolveUri,
}: {
  blocks: ViewBlock[];
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
}) {
  if (!Array.isArray(blocks)) return null;
  return (
    <div className="space-y-2">
      {latestRevisionBlocks(blocks).map((block) => {
        // Index-keyed (envelope-less) blocks key off their position in the
        // original array so collapsing a revision above them can't shift keys.
        const key = blockKey(block, blocks.indexOf(block));
        switch (block.type) {
          case "diagnosis":
            return <RunDiagnosisCard key={key} block={block} />;
          case "chart":
            return <AgentChart key={key} block={block} />;
          // The one progressive block: revisions share the investigationId, so
          // latest-wins above keeps a single live card.
          case "investigation":
            return <InvestigationCard key={key} block={block} resolveUri={resolveUri} />;
          case "report":
            return (
              <ReportView
                key={key}
                vm={block.vm}
                reportUri={block.reportUri}
                onIntent={onIntent}
                resolveUri={resolveUri}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
