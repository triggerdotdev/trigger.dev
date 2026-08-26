import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { createContext, useContext } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import { ASK_AGENT_LABEL } from "./agent-identity";

// Registered once, by `DashboardAgent`. The launcher only displays it.
export const TOGGLE_PANEL_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "j",
  // The composer holds focus while the panel is open, so the key must fire from
  // inside a text field.
  enabledOnInputElements: true,
  // Chrome binds Cmd/Ctrl-J to Show Downloads.
  preventDefault: true,
};

type DashboardAgentContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Sent as the first message of a new chat; with a chat open it only fills the composer. */
  openWith: (text: string) => void;
  /** Nothing is posted or persisted until the card is submitted. */
  openWithWatch: (spec: WatchSpec) => void;
  /** Polled only while the panel is closed; 0 while it is open. */
  unreadWakes: number;
  /** Chats that answered, settled or woke while the panel was closed. */
  unreadWork: number;
};

const DashboardAgentContext = createContext<DashboardAgentContextValue | null>(null);

export const DashboardAgentProvider = DashboardAgentContext.Provider;

// Null outside the env layout (no provider) or when the agent is gated off.
export function useDashboardAgent() {
  return useContext(DashboardAgentContext);
}

export function DashboardAgentLauncher() {
  const agent = useDashboardAgent();
  if (!agent) {
    return null;
  }

  const { open, setOpen, unreadWakes, unreadWork } = agent;
  const hasUnread = unreadWakes > 0 || unreadWork > 0;

  // Stays visible while the window is open, and toggles it: there is only ever one floating
  // window, so open->click closes it rather than re-affirming a no-op.
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
        <span className="relative inline-flex shrink-0">
          <Button
            variant="ask-trigger/small"
            aria-label={hasUnread ? `${ASK_AGENT_LABEL}, unread updates` : ASK_AGENT_LABEL}
            onClick={() => setOpen(!open)}
          >
            {ASK_AGENT_LABEL}
          </Button>
          {hasUnread && (
            // The ring matches the `NavBar` surface the launcher sits on.
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-indigo-500 ring-2 ring-background-bright" />
          )}
        </span>
      }
    />
  );
}
