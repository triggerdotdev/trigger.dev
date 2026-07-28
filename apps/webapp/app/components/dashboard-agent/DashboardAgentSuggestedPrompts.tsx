import { SparklesIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { AgentList, AgentListRow, AgentListRowAction } from "./list-row";
import {
  readDismissedPromptIds,
  resolveSuggestedPrompts,
  writeDismissedPromptId,
} from "./suggested-prompts";

/**
 * The chips on an empty chat.
 *
 * Everything shown here comes from the registry
 * (`suggested-prompts/`) resolved against the page the user is on — there is no
 * hardcoded list. Clicking a chip sends its `prompt` (the full question),
 * not its `label` (the short chip text). Dismissing one hides it for this user
 * and pulls the next candidate up into the row.
 */
export function DashboardAgentSuggestedPrompts({
  onSelect,
  pageContext,
  promoted,
  dismissedIds,
}: {
  /** Receives the prompt text to send, not the chip label. */
  onSelect: (prompt: string) => void;
  /** What the user is looking at. Omitted (no route mapper) means defaults only. */
  pageContext?: AgentPageContext;
  /** The product-controlled promoted chip, when one is configured. */
  promoted?: SuggestedPrompt;
  /**
   * Controlled dismissals. Normally omitted: the component reads and writes its
   * own localStorage. Passing this makes it stateless, which is what the
   * storybook gallery and tests want.
   */
  dismissedIds?: string[];
}) {
  const controlled = dismissedIds !== undefined;
  // Read once on mount: localStorage isn't reactive, and re-reading per render
  // would fight the local state below.
  const [storedDismissedIds, setStoredDismissedIds] = useState<string[]>(() =>
    controlled ? [] : readDismissedPromptIds()
  );

  const dismiss = useCallback(
    (promptId: string) => {
      if (controlled) return;
      writeDismissedPromptId(promptId);
      setStoredDismissedIds((ids) => (ids.includes(promptId) ? ids : [...ids, promptId]));
    },
    [controlled]
  );

  const effectiveDismissedIds = dismissedIds ?? storedDismissedIds;

  const prompts = useMemo(
    () =>
      resolveSuggestedPrompts(pageContext ?? { page: { kind: "other", path: "" }, signals: [] }, {
        promoted,
        dismissedIds: effectiveDismissedIds,
      }),
    [pageContext, promoted, effectiveDismissedIds]
  );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <SparklesIcon className="size-6 text-indigo-500" />
        <Paragraph variant="small" className="text-text-dimmed">
          Ask about your runs, errors, or how Trigger.dev works.
        </Paragraph>
      </div>
      <AgentList>
        {prompts.map((prompt) => (
          <AgentListRow
            key={prompt.id}
            label={prompt.label}
            variant={prompt.source === "promoted" ? "promoted" : "default"}
            onSelect={() => onSelect(prompt.prompt)}
            action={
              <AgentListRowAction
                icon={XMarkIcon}
                label={`Dismiss ${prompt.label}`}
                onClick={() => dismiss(prompt.id)}
              />
            }
          />
        ))}
      </AgentList>
    </div>
  );
}
