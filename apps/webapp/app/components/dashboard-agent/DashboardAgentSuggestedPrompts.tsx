import {
  BookOpenIcon,
  ChartBarIcon,
  EyeIcon,
  MagnifyingGlassIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
} from "@heroicons/react/20/solid";
import type { AgentPageContext, SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { useMemo, useState } from "react";
import { Button, type ButtonVariant } from "~/components/primitives/Buttons";
import type { RenderIcon } from "~/components/primitives/Icon";
import {
  readDismissedPromptIds,
  resolveSuggestedPromptsBySlot,
  type ResolvedPromptSlot,
} from "./suggested-prompts";

/** The only slot-to-button-style mapping: a new slot is styled here and nowhere else. */
export const PROMPT_SLOT_BUTTON: Record<
  ResolvedPromptSlot,
  { variant: ButtonVariant; icon: RenderIcon }
> = {
  promoted: { variant: "primary/small", icon: SparklesIcon },
  investigate: { variant: "primary/small", icon: MagnifyingGlassIcon },
  watch: { variant: "secondary/small", icon: EyeIcon },
  status: { variant: "secondary/small", icon: ChartBarIcon },
  explain: { variant: "tertiary/small", icon: QuestionMarkCircleIcon },
  docs: { variant: "docs/small", icon: BookOpenIcon },
};

/**
 * The suggested prompts on a blank chat, as a wrapping row of buttons.
 *
 * Prompts come from the `suggested-prompts/` registry resolved against the
 * current page; there is no hardcoded list. Dismissed prompts stay hidden, but
 * this surface never writes dismissals: only the row surfaces do.
 */
export function DashboardAgentSuggestedPrompts({
  onSelect,
  pageContext,
  promoted,
  dismissedIds,
}: {
  /** Receives the prompt text to send, not the button label. */
  onSelect: (prompt: string) => void;
  /** What the user is looking at. Omitted means defaults only. */
  pageContext?: AgentPageContext;
  /** The product-controlled promoted prompt, when one is configured. */
  promoted?: SuggestedPrompt;
  /**
   * Controlled dismissals. Normally omitted: the component reads its own
   * localStorage. Passing this makes it stateless, for the gallery and tests.
   */
  dismissedIds?: string[];
}) {
  // Read once on mount: re-reading per render would make the resolved set churn.
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
      {prompts.map(({ slot, prompt }) => {
        const style = PROMPT_SLOT_BUTTON[slot];
        return (
          <Button
            key={prompt.id}
            variant={style.variant}
            LeadingIcon={style.icon}
            onClick={() => onSelect(prompt.prompt)}
          >
            {prompt.label}
          </Button>
        );
      })}
    </div>
  );
}
