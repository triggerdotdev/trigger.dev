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
};

// Ask AI's old keystroke. Kept as an alias so the muscle memory lands somewhere; not advertised.
export const LEGACY_ASK_AI_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "i",
  enabledOnInputElements: true,
};

type DashboardAgentContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Sent as the first message of a new chat; with a chat open it only fills the composer. */
  openWith: (text: string) => void;
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

  const { open, setOpen } = agent;
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
        <span className="relative inline-flex shrink-0">
          <Button
            variant="ask-trigger/small"
            aria-label={ASK_AGENT_LABEL}
            onClick={() => setOpen(true)}
          >
            {ASK_AGENT_LABEL}
          </Button>
        </span>
      }
    />
  );
}
