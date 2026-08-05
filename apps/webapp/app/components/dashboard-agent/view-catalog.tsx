import type { AgentIntent, ViewBlock } from "@internal/dashboard-agent-contracts";
import { ActionsBlock } from "./ActionsBlock";
import { AgentChart } from "./AgentChart";
import { InvestigationCard } from "./InvestigationCard";
import { ReportView, type ResolvedUri } from "./ReportView";
import { RunDiagnosisCard } from "./RunDiagnosisCard";
import { blockKey, latestRevisionBlocks } from "./view-blocks";
import { WatchResultBlock } from "./WatchResultBlock";

// The render registry for the agent's view catalog. Each block `type` maps to a
// component; unknown types are skipped, so an older or newer agent can never
// render arbitrary content. Add a block with a `case` here plus a union member
// in the package's `viewBlockSchema`.
//
// Blocks carrying an envelope (`id` + `revision`) are keyed by identity and
// collapsed latest-wins, so a re-emitted block replaces its earlier revision.
// Envelope-less blocks are keyed by index. See `view-blocks.ts`.
export function ViewBlocks({
  blocks,
  /**
   * Where a card's actions go. Cards never navigate or ask on their own: they
   * emit an intent and the host honours it. Without it, intent-only actions
   * render as plain text rather than dead buttons.
   */
  onIntent,
  /**
   * Host resolver for `trigger://` URIs cited by a card. Only the host knows the
   * environment to resolve against; see `resolveTriggerUri.server.ts`.
   */
  resolveUri,
  /** Host-resolved dashboard paths for settings-page footer actions. */
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
        // Envelope-less blocks key off their position in the original array so
        // collapsing a revision above them can't shift keys.
        const key = blockKey(block, blocks.indexOf(block));
        switch (block.type) {
          case "diagnosis":
            return <RunDiagnosisCard key={key} block={block} />;
          case "chart":
            return <AgentChart key={key} block={block} onIntent={onIntent} />;
          case "actions":
            return <ActionsBlock key={key} block={block} onIntent={onIntent} />;
          // The one progressive block: revisions share the investigationId, so
          // latest-wins keeps a single live card.
          case "investigation":
            return (
              <InvestigationCard
                key={key}
                block={block}
                resolveUri={resolveUri}
                onIntent={onIntent}
              />
            );
          // Host-emitted only (the watch card's submit path), so the model cannot
          // fabricate a confirmation.
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
