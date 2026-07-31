import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentSuggestedPrompts } from "./DashboardAgentSuggestedPrompts";
import type { AgentPageContext } from "./page-context-types";

/**
 * The new-chat "draft" state: suggested prompts + composer with no transport
 * mounted and no chat id yet. The chat id is server-owned, so the first send
 * goes to the panel's `create` call, which generates the id and returns it;
 * only then does the real `DashboardAgentChat` mount. The client never invents
 * a chat id.
 */
export function DashboardAgentDraft({
  onSubmit,
  projectSlug,
  environmentSlug,
  currentPage,
  pageContext,
  promotedPrompt,
}: {
  onSubmit: (text: string) => void;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
  // What the user is looking at, so the suggested prompts can react to it.
  pageContext?: AgentPageContext;
  // The product-controlled promoted chip, from the feature flag.
  promotedPrompt?: SuggestedPrompt;
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
    <>
      <DashboardAgentSuggestedPrompts
        onSelect={submit}
        pageContext={pageContext}
        promoted={promotedPrompt}
      />
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
  );
}
