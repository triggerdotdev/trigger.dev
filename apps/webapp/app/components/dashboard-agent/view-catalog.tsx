import type { ViewBlock } from "@internal/dashboard-agent";
import { AgentChart } from "./AgentChart";
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
export function ViewBlocks({ blocks }: { blocks: ViewBlock[] }) {
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
          default:
            return null;
        }
      })}
    </div>
  );
}
