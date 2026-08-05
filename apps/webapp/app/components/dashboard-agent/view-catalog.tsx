import type { AgentIntent, ViewBlock } from "@internal/dashboard-agent-contracts";
import { ActionsBlock } from "./ActionsBlock";
import { AgentChart } from "./AgentChart";
import { InvestigationCard } from "./InvestigationCard";
import { ReportView, type ResolvedUri } from "./ReportView";
import { RunDiagnosisCard } from "./RunDiagnosisCard";
import { blockKey, latestRevisionBlocks } from "./view-blocks";
import { WatchResultBlock } from "./WatchResultBlock";

// Unknown block types are skipped, so an older or newer agent cannot render
// arbitrary content. A new block needs a `case` here and a `viewBlockSchema` member.
export function ViewBlocks({
  blocks,
  onIntent,
  resolveUri,
  pagePaths,
}: {
  blocks: ViewBlock[];
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
}) {
  if (!Array.isArray(blocks)) return null;
  return (
    <div className="space-y-2">
      {latestRevisionBlocks(blocks).map((block) => {
        // Index into the original array, so collapsing a revision above an
        // envelope-less block can't shift its key.
        const key = blockKey(block, blocks.indexOf(block));
        switch (block.type) {
          case "diagnosis":
            return <RunDiagnosisCard key={key} block={block} />;
          case "chart":
            return <AgentChart key={key} block={block} onIntent={onIntent} />;
          case "actions":
            return <ActionsBlock key={key} block={block} onIntent={onIntent} />;
          // Revisions share the investigationId, so latest-wins keeps one card.
          case "investigation":
            return (
              <InvestigationCard
                key={key}
                block={block}
                resolveUri={resolveUri}
                onIntent={onIntent}
              />
            );
          // Host-emitted only, so the model cannot fabricate a confirmation.
          case "watch_result":
            return <WatchResultBlock key={key} block={block} />;
          case "report":
            return (
              <ReportView
                key={key}
                vm={block.vm}
                reportUri={block.reportUri}
                onIntent={onIntent}
                resolveUri={resolveUri}
                pagePaths={pagePaths}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
