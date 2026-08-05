import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { createContext, useContext } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { Shortcut } from "~/hooks/useShortcutKeys";

/**
 * Opens and closes the panel. Registered once, by `DashboardAgent`; the launcher
 * only displays it, so the tooltip and the binding can't drift apart.
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
   * Open the panel with `text` in play: sent as the first message of a new chat
   * when nothing is open, otherwise dropped into the open chat's composer so an
   * in-progress conversation is never hijacked.
   */
  openWith: (text: string) => void;
  /**
   * Open the panel with a watch card pre-filled. Deliberately not `openWith`: a
   * card is not a message, so nothing is posted to the transcript or persisted
   * until the card is submitted and an abandoned card leaves no trace.
   */
  openWithWatch: (spec: WatchSpec) => void;
  /**
   * Watch wakes the user hasn't seen. Polled only while the panel is closed;
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
  // The open panel has its own Close button and Esc, so the header toggle goes.
  if (open) {
    return null;
  }

  const hasUnread = unreadWakes > 0;

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
        <span className="relative inline-flex shrink-0">
          <Button
            variant="ask-ai/small"
            aria-label={hasUnread ? "Ask Trigger, unread updates" : "Ask Trigger"}
            onClick={() => setOpen(true)}
          >
            Ask Trigger
          </Button>
          {hasUnread && (
            <span
              // Ringed so the dot reads on the header background and the button.
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-indigo-500 ring-2 ring-background-dimmed"
            />
          )}
        </span>
      }
    />
  );
}
