import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import { AgentUpgradeBlock } from "./AgentUpgradeGate";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import { MESSAGE_QUOTA_REACHED_REASON } from "./message-quota";
import type { AgentPageContext } from "./page-context-types";
import { readDismissedPromptIds, resolveSuggestedPromptsBySlot } from "./suggested-prompts";

// Chat ids are server-owned: the first send goes to the panel's `create` call, which
// returns the id, and only then does `DashboardAgentChat` mount.
export function DashboardAgentDraft({
  onSubmit,
  projectName,
  environmentSlug,
  entityId,
  pageContext,
  promotedPrompt,
  watchCard,
  capReached,
}: {
  onSubmit: (text: string) => void;
  projectName: string;
  environmentSlug: string;
  entityId?: string;
  pageContext?: AgentPageContext;
  promotedPrompt?: SuggestedPrompt;
  watchCard?: React.ReactNode;
  capReached?: { limit: number; planResolved: boolean } | null;
}) {
  const [input, setInput] = useState("");

  // Same resolution the hero's buttons use, so the placeholder matches the first button.
  const [dismissedIds] = useState(readDismissedPromptIds);
  const placeholderSuggestion = useMemo(
    () =>
      resolveSuggestedPromptsBySlot(
        pageContext ?? { page: { kind: "other", path: "" }, signals: [] },
        {
          promoted: promotedPrompt,
          dismissedIds,
        }
      )[0]?.prompt.prompt,
    [pageContext, promotedPrompt, dismissedIds]
  );

  const submit = useCallback(
    (text: string) => {
      // Suggested prompts reach here via the hero, bypassing the composer's cap guard.
      if (capReached) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setInput("");
      onSubmit(trimmed);
    },
    [onSubmit, capReached]
  );

  return (
    <DashboardAgentHero
      onSelect={submit}
      pageContext={pageContext}
      promoted={promotedPrompt}
      promptsDisabledReason={capReached ? MESSAGE_QUOTA_REACHED_REASON : undefined}
      composer={
        capReached ? (
          <div className="flex w-full flex-col gap-3">
            {watchCard}
            <AgentUpgradeBlock
              limit={capReached.limit}
              planResolved={capReached.planResolved}
              context={
                <DashboardAgentContextBanner
                  projectName={projectName}
                  environmentSlug={environmentSlug}
                  entityId={entityId}
                />
              }
            />
          </div>
        ) : (
          <div className="flex w-full flex-col gap-3">
            {watchCard}
            <DashboardAgentComposer
              layout="hero"
              value={input}
              onChange={setInput}
              onSubmit={() => submit(input)}
              onStop={() => {}}
              isStreaming={false}
              placeholderSuggestion={watchCard ? undefined : placeholderSuggestion}
              context={
                <DashboardAgentContextBanner
                  projectName={projectName}
                  environmentSlug={environmentSlug}
                  entityId={entityId}
                />
              }
            />
          </div>
        )
      }
    />
  );
}
