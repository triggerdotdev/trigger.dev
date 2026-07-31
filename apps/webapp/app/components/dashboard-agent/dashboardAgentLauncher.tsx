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
  /**
   * Watch wakes the user hasn't seen. Polled only while the panel is closed —
   * with it open the chat itself is the notification, so this stays at 0.
   */
  unreadWakes: number;
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

  const { open, setOpen, unreadWakes } = agent;
  // Only meaningful while closed: an open panel shows the wake itself.
  const hasUnread = !open && unreadWakes > 0;

  return (
    <SimpleTooltip
      asChild
      tabbable
      disableHoverableContent
      content={
        <span className="flex items-center">
          {open ? "Close chat" : "Open chat"}
          <ShortcutKey shortcut={TOGGLE_PANEL_SHORTCUT} variant="medium" />
        </span>
      }
      button={
        <button
          type="button"
          aria-label={hasUnread ? "Open chat, unread updates" : open ? "Close chat" : "Open chat"}
          aria-pressed={open}
          onClick={() => setOpen(!open)}
          className={cn(
            "relative flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-text-bright transition",
            open
              ? "border-border-brighter bg-background-hover"
              : "border-border-bright bg-background-bright hover:border-border-brighter"
          )}
        >
          <ChatBubbleLeftRightIcon className="size-3.5 text-indigo-500" />
          Chat
          {hasUnread && (
            <span
              // Ringed so the dot reads on the header background as well as the button.
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-indigo-500 ring-2 ring-background-dimmed"
            />
          )}
        </button>
      }
    />
  );
}
