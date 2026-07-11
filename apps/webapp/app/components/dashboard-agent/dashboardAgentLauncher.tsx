import { ChatBubbleLeftRightIcon, ChevronDoubleRightIcon } from "@heroicons/react/20/solid";
import { createContext, useContext } from "react";
import { cn } from "~/utils/cn";

type DashboardAgentContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
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

  return (
    <button
      type="button"
      aria-label={open ? "Collapse chat" : "Open chat"}
      onClick={() => setOpen(!open)}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-text-bright transition",
        open
          ? "border-border-brighter bg-background-hover"
          : "border-border-bright bg-background-bright hover:border-border-brighter"
      )}
    >
      {open ? (
        <ChevronDoubleRightIcon className="size-3.5 text-text-dimmed" />
      ) : (
        <ChatBubbleLeftRightIcon className="size-3.5 text-indigo-500" />
      )}
      {open ? "Collapse" : "Chat"}
    </button>
  );
}
