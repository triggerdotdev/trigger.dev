import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import { DashboardAgentComposer } from "./DashboardAgentComposer";
import { DashboardAgentContextBanner } from "./DashboardAgentContextBanner";
import { DashboardAgentHero } from "./DashboardAgentHero";
import type { AgentPageContext } from "./page-context-types";
import { readDismissedPromptIds, resolveSuggestedPromptsBySlot } from "./suggested-prompts";

// Chat ids are server-owned: the first send goes to the panel's `create` call, which
// returns the id, and only then does `DashboardAgentChat` mount.
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
  pageContext?: AgentPageContext;
  promotedPrompt?: SuggestedPrompt;
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
        <div className="flex w-full flex-col gap-3">
          <DashboardAgentComposer
            layout="hero"
            value={input}
            onChange={setInput}
            onSubmit={() => submit(input)}
            onStop={() => {}}
            isStreaming={false}
            placeholderSuggestion={placeholderSuggestion}
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
