import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import type { AgentPageContext } from "./page-context-types";

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
<<<<<<< HEAD
    <>
      <DashboardAgentSuggestedPrompts
        onSelect={submit}
        pageContext={pageContext}
        promoted={promotedPrompt}
      />
      {watchCard}
      <DashboardAgentComposer
        value={input}
        onChange={setInput}
        onSubmit={() => submit(input)}
        onStop={() => {}}
        isStreaming={false}
        context={
          <DashboardAgentContextBanner
            projectSlug={projectSlug}
            environmentSlug={environmentSlug}
            currentPage={currentPage}
          />
        }
      />
    </>
=======
    <DashboardAgentHero
      onSelect={submit}
      pageContext={pageContext}
      promoted={promotedPrompt}
      composer={
        <DashboardAgentComposer
          layout="hero"
          value={input}
          onChange={setInput}
          onSubmit={() => submit(input)}
          onStop={() => {}}
          isStreaming={false}
          context={
            <DashboardAgentContextBanner
              projectSlug={projectSlug}
              environmentSlug={environmentSlug}
              currentPage={currentPage}
            />
          }
        />
      }
    />
>>>>>>> origin/feat/dashboard-agent-flows
  );
}
