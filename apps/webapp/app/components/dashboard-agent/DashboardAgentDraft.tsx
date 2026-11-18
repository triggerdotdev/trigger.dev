import { sliceWellFormed, type SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useState } from "react";
import { AgentUpgradeBlock } from "./AgentUpgradeGate";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import { MAX_MESSAGE_CHARS } from "./message-limits";
import { MESSAGE_QUOTA_REACHED_REASON } from "./message-quota";
import type { AgentPageContext } from "./page-context-types";

// Chat ids are server-owned: the first send goes to the panel's `create` call, which
// returns the id, and only then does `DashboardAgentChat` mount.
export function DashboardAgentDraft({
  onSubmit,
  prefill,
  projectName,
  environmentSlug,
  entityId,
  pageContext,
  promotedPrompt,
  capReached,
  autoFocus,
}: {
  onSubmit: (text: string) => void;
  /** Fills the composer without sending. */
  prefill?: { text: string; seq: number };
  projectName: string;
  environmentSlug: string;
  entityId?: string;
  pageContext?: AgentPageContext;
  promotedPrompt?: SuggestedPrompt;
  capReached?: { limit: number; planResolved: boolean } | null;
  /** Off where several drafts share a page, e.g. the gallery. */
  autoFocus?: boolean;
}) {
  const [input, setInput] = useState("");
  const [focusKey, setFocusKey] = useState<number | undefined>(undefined);

  const [appliedSeq, setAppliedSeq] = useState<number | undefined>(undefined);
  if (prefill && prefill.seq !== appliedSeq) {
    setAppliedSeq(prefill.seq);
    setInput(sliceWellFormed(prefill.text, MAX_MESSAGE_CHARS));
    setFocusKey(prefill.seq);
  }

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
            <DashboardAgentComposer
              layout="hero"
              value={input}
              onChange={setInput}
              onSubmit={() => submit(input)}
              onStop={() => {}}
              isStreaming={false}
              autoFocus={(autoFocus ?? true) || focusKey !== undefined}
              focusKey={focusKey}
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
