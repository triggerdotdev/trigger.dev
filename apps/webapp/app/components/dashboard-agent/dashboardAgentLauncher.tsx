import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { createContext, useContext } from "react";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";

/**
 * Opens and closes the panel. Registered once, by `DashboardAgent`; the launcher
 * only shows it, so the tooltip and the binding can't drift apart.
 */
export const TOGGLE_PANEL_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "j",
  // The composer holds focus while the panel is open, so the same keystroke has
  // to close it from inside the text field.
  enabledOnInputElements: true,
};

type DashboardAgentContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /**
   * Open the panel with `text` already in play: sent as the first message of a
   * new chat when nothing is open, or dropped into the composer of the chat
   * that's already open (so an in-progress conversation is never hijacked).
   */
  openWith: (text: string) => void;
};

const DashboardAgentContext = createContext<DashboardAgentContextValue | null>(null);

export const DashboardAgentProvider = DashboardAgentContext.Provider;

// Null outside the env layout (no provider) or when the agent is gated off, so
// the launcher self-hides everywhere it can't open.
export function useDashboardAgent() {
  return useContext(DashboardAgentContext);
}

export function DashboardAgentLauncher() {
  const agent = useDashboardAgent();
  if (!agent) {
    return null;
  }

  const { open, setOpen } = agent;
  // The open panel has its own Close button and Esc — a second toggle in the
  // page header would just be noise.
  if (open) {
    return null;
  }

  return (
    <SimpleTooltip
      asChild
      tabbable
      disableHoverableContent
      content={
        <span className="flex items-center">
          Open chat
          <ShortcutKey shortcut={TOGGLE_PANEL_SHORTCUT} variant="medium" />
        </span>
      }
      button={
        <button
          type="button"
          aria-label="Ask Trigger"
          onClick={() => setOpen(true)}
          className={cn(
            "relative flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-text-bright transition",
            "border-border-bright bg-background-bright hover:border-border-brighter"
          )}
        >
          <ChatBubbleLeftRightIcon className="size-3.5 text-indigo-500" />
          Ask Trigger
        </button>
      }
    />
  );
}
