import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useMemo, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { readDismissedPromptIds, resolveSuggestedPromptsBySlot } from "./suggested-prompts";

// Every slot renders the same way: no per-slot styling to keep in sync here.
const PROMPT_BUTTON_VARIANT = "secondary/small";

// This surface never writes dismissals; only the row surfaces do.
export function DashboardAgentSuggestedPrompts({
  onSelect,
  pageContext,
  promoted,
  dismissedIds,
  disabledReason,
}: {
  /** Receives the prompt text to send, not the button label. */
  onSelect: (prompt: string) => void;
  /** Omitted means defaults only. */
  pageContext?: AgentPageContext;
  promoted?: SuggestedPrompt;
  /** Omitted means the component reads its own localStorage. */
  dismissedIds?: string[];
  /** Set to disable every chip and say why, e.g. over the message cap. */
  disabledReason?: string;
}) {
  // Read once on mount: re-reading per render churns the resolved set.
  const [storedDismissedIds] = useState<string[]>(() =>
    dismissedIds !== undefined ? [] : readDismissedPromptIds()
  );

  const effectiveDismissedIds = dismissedIds ?? storedDismissedIds;

  const prompts = useMemo(
    () =>
      resolveSuggestedPromptsBySlot(
        pageContext ?? { page: { kind: "other", path: "" }, signals: [] },
        { promoted, dismissedIds: effectiveDismissedIds }
      ),
    [pageContext, promoted, effectiveDismissedIds]
  );

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {prompts.map(({ prompt }) => (
        <Button
          key={prompt.id}
          variant={PROMPT_BUTTON_VARIANT}
          onClick={() => onSelect(prompt.prompt)}
          disabled={!!disabledReason}
          tooltip={disabledReason}
          aria-label={disabledReason ? `${prompt.label} — ${disabledReason}` : undefined}
        >
          {prompt.label}
        </Button>
      ))}
    </div>
  );
}
