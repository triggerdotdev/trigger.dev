import type { AgentIntent, ViewBlock } from "@internal/dashboard-agent-contracts";
import { ActionsBlock } from "./ActionsBlock";
import { AgentChart } from "./AgentChart";
import { InvestigationCard } from "./InvestigationCard";
import { ReportView, type ResolvedUri } from "./ReportView";
import { RunDiagnosisCard } from "./RunDiagnosisCard";
import { blockKey, latestRevisionEntries } from "./view-blocks";
import { cardAlreadyOffersWatch } from "./view-actions";
import { WatchResultBlock } from "./WatchResultBlock";

// Unknown block types are skipped, so an older or newer agent cannot render
// arbitrary content. A new block needs a `case` here and a `viewBlockSchema` member.
export function ViewBlocks({
  blocks,
  onIntent,
  resolveUri,
  pagePaths,
  answered = false,
  watchOfferedInTurn = false,
}: {
  blocks: ViewBlock[];
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
  /** The turn kept answering after this card, so "keep digging" has nothing to ask for. */
  answered?: boolean;
  /** A card in another of this turn's parts already offers the watch; see `view-actions`. */
  watchOfferedInTurn?: boolean;
}) {
  if (!Array.isArray(blocks)) return null;
  const entries = latestRevisionEntries(blocks);
  const watchOfferedOnCard =
    watchOfferedInTurn || cardAlreadyOffersWatch(entries.map((entry) => entry.block));
  return (
    <div className="space-y-2">
      {entries.map(({ block, index }) => {
        // The original array's index, so collapsing a revision above an
        // envelope-less block can't shift its key.
        const key = blockKey(block, index);
        switch (block.type) {
          case "diagnosis":
            return <RunDiagnosisCard key={key} block={block} />;
          case "chart":
            return <AgentChart key={key} block={block} onIntent={onIntent} />;
          case "actions":
            return (
              <ActionsBlock
                key={key}
                block={block}
                onIntent={onIntent}
                dropWatch={watchOfferedOnCard}
              />
            );
          // Revisions share the investigationId, so latest-wins keeps one card.
          case "investigation":
            return (
              <InvestigationCard
                key={key}
                block={block}
                resolveUri={resolveUri}
                onIntent={onIntent}
                answered={answered}
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
