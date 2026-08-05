import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import type { AgentPageContext } from "./page-context-types";
import { readDismissedPromptIds, resolveSuggestedPromptsBySlot } from "./suggested-prompts";

/**
 * The new-chat draft state: the blank-state hero, with no transport mounted and
 * no chat id yet. The chat id is server-owned, so the first send goes to the
 * panel's `create` call, which returns the id; only then does
 * `DashboardAgentChat` mount. The client never invents a chat id.
 */
export function DashboardAgentDraft({
  onSubmit,
  projectSlug,
  environmentSlug,
  currentPage,
  pageContext,
  promotedPrompt,
  watchCard,
}: {
  onSubmit: (text: string) => void;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
  // What the user is looking at, so the suggested prompts can react to it.
  pageContext?: AgentPageContext;
  // The promoted chip, from the feature flag.
  promotedPrompt?: SuggestedPrompt;
  /** The ephemeral watch card, when one is open. Sits above the composer. */
  watchCard?: React.ReactNode;
}) {
  const [input, setInput] = useState("");

  // The top resolved prompt doubles as the field's placeholder. Same resolution
  // the hero's buttons use, so it always matches the first button.
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
      const trimmed = text.trim();
      if (!trimmed) return;
      setInput("");
      onSubmit(trimmed);
    },
    [onSubmit]
  );

  return (
    <DashboardAgentHero
      onSelect={submit}
      pageContext={pageContext}
      promoted={promotedPrompt}
      composer={
        // The card sits directly above the field, the same place a chat puts it.
        <div className="flex w-full flex-col gap-3">
          {watchCard}
          <DashboardAgentComposer
            layout="hero"
            value={input}
            onChange={setInput}
            onSubmit={() => submit(input)}
            onStop={() => {}}
            isStreaming={false}
            // With the card open the field goes quiet, so the two don't compete.
            placeholderSuggestion={watchCard ? undefined : placeholderSuggestion}
            context={
              <DashboardAgentContextBanner
                projectSlug={projectSlug}
                environmentSlug={environmentSlug}
                currentPage={currentPage}
              />
            }
          />
        </div>
      }
    />
  );
}
