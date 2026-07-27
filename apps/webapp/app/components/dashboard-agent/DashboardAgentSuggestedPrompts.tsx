import { SparklesIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useCallback, useMemo, useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
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
      <div className="flex w-full flex-col gap-1.5">
        {prompts.map((prompt) => (
          <div key={prompt.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(prompt.prompt)}
              className={cn(
                "flex-1 rounded-md border px-3 py-2 text-left text-sm transition",
                prompt.source === "promoted"
                  ? "border-indigo-500/40 bg-indigo-500/5 text-text-bright hover:border-indigo-500/60"
                  : "border-grid-bright bg-background-bright/40 text-text-dimmed hover:border-border-bright hover:text-text-bright"
              )}
            >
              {prompt.label}
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${prompt.label}`}
              onClick={() => dismiss(prompt.id)}
              className="shrink-0 rounded p-1 text-text-faint opacity-0 transition-opacity hover:text-text-bright group-hover:opacity-100 focus-visible:opacity-100"
            >
              <XMarkIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
