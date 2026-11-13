import type { AgentIntent, ViewBlock } from "@internal/dashboard-agent-contracts";
import { AlertCreatedCard } from "~/components/alerts/creationCards";
import { ActionsBlock } from "./ActionsBlock";
import { AgentChart } from "./AgentChart";
import { InvestigationCard } from "./InvestigationCard";
import { ReportView, type ResolvedUri } from "./ReportView";
import { RunDiagnosisCard } from "./RunDiagnosisCard";
import { blockKey, latestRevisionEntries } from "./view-blocks";

// Unknown block types are skipped, so an older or newer agent cannot render
// arbitrary content. A new block needs a `case` here and a `viewBlockSchema` member.
export function ViewBlocks({
  blocks,
  onIntent,
  resolveUri,
  pagePaths,
  answered = false,
  followedByPlan = false,
}: {
  blocks: ViewBlock[];
  onIntent?: (intent: AgentIntent) => boolean | void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
  /** The turn kept answering after this card, so "keep digging" has nothing to ask for. */
  answered?: boolean;
  followedByPlan?: boolean;
}) {
  if (!Array.isArray(blocks)) return null;
  const entries = latestRevisionEntries(blocks);
  return (
    <div className="space-y-2">
      {entries.map(({ block, index }) => {
        // The original array's index, so collapsing a revision above an
        // envelope-less block can't shift its key.
        const key = blockKey(block, index);
        switch (block.type) {
          case "diagnosis":
            return <RunDiagnosisCard key={key} block={block} resolveUri={resolveUri} />;
          case "chart":
            return <AgentChart key={key} block={block} onIntent={onIntent} />;
          case "actions":
            return (
              <ActionsBlock
                key={key}
                block={block}
                onIntent={onIntent}
                followedByPlan={followedByPlan}
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
          case "alert_created":
            return <AlertCreatedCard key={key} block={block} />;
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
