import type { ViewBlock } from "@internal/dashboard-agent";
import { AgentChart } from "./AgentChart";
import { RunDiagnosisCard } from "./RunDiagnosisCard";

// The render registry for the dashboard agent's view catalog — our small
// "generative UI" layer. The agent emits a `render_view` tool call whose output
// is `{ blocks: ViewBlock[] }` (a spec drawn from the catalog defined in
// internal-packages/dashboard-agent). Here we map each block `type` to its
// component. Unknown types are skipped, so an older/newer agent can never
// render arbitrary content — same guarantee a generative-UI framework gives,
// without the dependency. Add a block by adding a `case` here and a union
// member in the package's `viewBlockSchema`.
export function ViewBlocks({ blocks }: { blocks: ViewBlock[] }) {
  if (!Array.isArray(blocks)) return null;
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "diagnosis":
            return <RunDiagnosisCard key={i} block={block} />;
          case "chart":
            return <AgentChart key={i} block={block} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
