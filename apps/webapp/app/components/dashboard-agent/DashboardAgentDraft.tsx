import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import type { AgentPageContext } from "./page-context-types";
import { readDismissedPromptIds, resolveSuggestedPromptsBySlot } from "./suggested-prompts";

/**
 * The new-chat "draft" state: the blank-state hero — title, subtitle, the field
 * you type in and the suggested prompts — with no transport mounted and no chat
 * id yet. The chat id is server-owned, so the first send goes to the panel's
 * `create` call, which generates the id and returns it; only then does the real
 * `DashboardAgentChat` mount. The client never invents a chat id.
 *
 * The composer lives inside the hero here and docks to the bottom of the panel
 * once a chat exists — the same component either way, so nothing about the field
 * (focus, caret, keybindings) changes across that switch.
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
  // The product-controlled promoted chip, from the feature flag.
  promotedPrompt?: SuggestedPrompt;
  /** The ephemeral watch card, when one is open. Sits above the composer. */
  watchCard?: React.ReactNode;
}) {
  const [input, setInput] = useState("");

  // The top resolved prompt doubles as the field's placeholder (Tab accepts it
  // as editable text). Same resolution the hero's buttons use, so the
  // placeholder is always the first button the user sees.
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
        // The card rides in the composer slot, directly above the field — the
        // same place a chat puts it, so an ephemeral card reads the same in the
        // blank state as it does mid-conversation.
        <div className="flex w-full flex-col gap-3">
          {watchCard}
          <DashboardAgentComposer
            layout="hero"
            value={input}
            onChange={setInput}
            onSubmit={() => submit(input)}
            onStop={() => {}}
            isStreaming={false}
            // With the card open the field goes quiet: two competing calls to
            // action in one block read as noise.
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
