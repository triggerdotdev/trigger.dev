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

/**
 * How a prompt's slot becomes a button. The single mapping from meaning to
 * variant, so a new slot is styled here and nowhere else:
 *
 * - `promoted` / `investigate` — something to do about a problem, so they get
 *   the indigo primary the rest of the app uses for the main action.
 * - `watch` — "tell me when this changes", a standing offer: secondary.
 * - `explain` — the evergreen question, the quietest of the set: tertiary.
 * - `docs` — a documentation question, so it gets the docs variant, the same
 *   style every "read the docs" button in the dashboard has.
 */
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
 * Everything shown here comes from the registry (`suggested-prompts/`) resolved
 * against the page the user is on — there is no hardcoded list. Clicking a
 * button sends its `prompt` (the full question), not its `label` (the short
 * button text).
 *
 * Previously dismissed prompts stay hidden (the stored ids are read on mount),
 * but a button carries no dismiss control of its own: an "x" on a button in a
 * wrapping row reads as a close, not as "don't offer this again". Dismissals are
 * therefore only ever written by surfaces that show prompts as rows.
 */
export function DashboardAgentSuggestedPrompts({
  onSelect,
  pageContext,
  promoted,
  dismissedIds,
}: {
  /** Receives the prompt text to send, not the button label. */
  onSelect: (prompt: string) => void;
  /** What the user is looking at. Omitted (no route mapper) means defaults only. */
  pageContext?: AgentPageContext;
  /** The product-controlled promoted prompt, when one is configured. */
  promoted?: SuggestedPrompt;
  /**
   * Controlled dismissals. Normally omitted: the component reads its own
   * localStorage. Passing this makes it stateless, which is what the storybook
   * gallery and tests want.
   */
  dismissedIds?: string[];
}) {
  // Read once on mount: localStorage isn't reactive, and re-reading per render
  // would make the resolved set churn.
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
