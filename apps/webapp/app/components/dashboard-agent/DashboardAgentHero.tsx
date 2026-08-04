import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { BetaBadge } from "~/components/FeatureBadges";
import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { DashboardAgentSuggestedPrompts } from "./DashboardAgentSuggestedPrompts";

/**
 * The blank state: what the panel shows before there is a conversation.
 *
 * Centred in whatever space it is given — the 380px side panel or the fullscreen
 * takeover — because a blank state has nothing to anchor to the top. The order is
 * icon, title, subtitle, the field you type in, then the prompts, so the eye
 * lands on the thing to do.
 *
 * `composer` is passed in rather than mounted here: the draft state puts its
 * composer *inside* the hero (there is nothing else on screen to dock it to),
 * while a chat that happens to have no messages keeps its own docked composer at
 * the bottom of the panel and passes nothing.
 */
export function DashboardAgentHero({
  onSelect,
  pageContext,
  promoted,
  dismissedIds,
  composer,
}: {
  /** Receives the prompt text to send, not the button label. */
  onSelect: (prompt: string) => void;
  pageContext?: AgentPageContext;
  promoted?: SuggestedPrompt;
  /** Controlled dismissals — see `DashboardAgentSuggestedPrompts`. */
  dismissedIds?: string[];
  /** The composer, when this hero owns it (the draft state). */
  composer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div className="flex w-full max-w-2xl flex-col items-center gap-5">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <Header1 className="flex items-center gap-2">
            <AgentMonoLogo size={22} decorative />
            Ask Trigger
            <BetaBadge />
          </Header1>
          <Paragraph variant="small" className="text-text-dimmed">
            About your runs, errors, or how Trigger.dev works.
          </Paragraph>
        </div>
        {composer}
        <DashboardAgentSuggestedPrompts
          onSelect={onSelect}
          pageContext={pageContext}
          promoted={promoted}
          dismissedIds={dismissedIds}
        />
      </div>
    </div>
  );
}
