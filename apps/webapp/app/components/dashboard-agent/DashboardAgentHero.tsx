import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { BetaBadge } from "~/components/FeatureBadges";
import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { DashboardAgentSuggestedPrompts } from "./DashboardAgentSuggestedPrompts";

export function DashboardAgentHero({
  onSelect,
  pageContext,
  promoted,
  dismissedIds,
  composer,
  promptsDisabledReason,
}: {
  /** Receives the prompt text to send, not the button label. */
  onSelect: (prompt: string) => void;
  pageContext?: AgentPageContext;
  promoted?: SuggestedPrompt;
  dismissedIds?: string[];
  composer?: React.ReactNode;
  /** Set to disable the suggestion chips and say why. */
  promptsDisabledReason?: string;
}) {
  // Centred by the child's `m-auto`, not by `justify-center`: auto margins give up their space
  // once the content outgrows the panel, so the heading stays scrollable to.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-5">
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
          disabledReason={promptsDisabledReason}
        />
      </div>
    </div>
  );
}
