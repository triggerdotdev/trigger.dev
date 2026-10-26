import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { createContext, useContext } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import { ASK_AGENT_LABEL } from "./agent-identity";
import type { AgentOpenSource } from "./manual-setup-action";
import type { DraftPrefillParams } from "./alert-creation/flow-state";
import type { EditAlertPrefill } from "~/components/alerts/EditAlertTranscript";

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
  /** Sent as the first message of a new chat; with a chat open it only fills the composer.
   * `source` names a contextual entry point (e.g. the alerts page), read by the header's
   * "Manual setup" action so it never shows for a chat opened any other way. */
  openWith: (text: string, options?: { source?: AgentOpenSource }) => void;
  /** Nothing is posted or persisted until the card is submitted. */
  openWithWatch: (spec: WatchSpec) => void;
  /** Opens the panel in alert-creation mode with a prefill, without navigating. */
  openCreateAlert: (prefill: DraftPrefillParams) => void;
  /** Opens the panel with a wizard card for the alert's editable fields. */
  openEditAlert: (prefill: EditAlertPrefill) => void;
  /** Polled only while the panel is closed; 0 while it is open. */
  unreadWakes: number;
  /** Chats that answered, settled or woke while the panel was closed. */
  unreadWork: number;
  /** Watch functionality is behind this flag; `WatchButton` renders nothing without it. */
  watchEnabled: boolean;
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

  const launcher = (
    <span className="relative inline-flex shrink-0">
      <Button
        variant="ask-trigger/small"
        aria-label={hasUnread ? `${ASK_AGENT_LABEL}, unread updates` : ASK_AGENT_LABEL}
        disabled={open}
        onClick={() => setOpen(true)}
      >
        {ASK_AGENT_LABEL}
      </Button>
      {hasUnread && (
        // The ring matches the `NavBar` surface the launcher sits on.
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background-bright" />
      )}
    </span>
  );

  if (open) return launcher;

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
      button={launcher}
    />
  );
}
