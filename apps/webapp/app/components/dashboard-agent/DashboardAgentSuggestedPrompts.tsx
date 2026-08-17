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

// The only slot-to-button-style mapping: a new slot is styled here and nowhere else.
const PROMPT_SLOT_BUTTON: Record<
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
      {prompts.map(({ slot, prompt }) => {
        const style = PROMPT_SLOT_BUTTON[slot];
        return (
          <Button
            key={prompt.id}
            variant={style.variant}
            LeadingIcon={style.icon}
            onClick={() => onSelect(prompt.prompt)}
            disabled={!!disabledReason}
            tooltip={disabledReason}
            aria-label={disabledReason ? `${prompt.label} — ${disabledReason}` : undefined}
          >
            {prompt.label}
          </Button>
        );
      })}
    </div>
  );
}
