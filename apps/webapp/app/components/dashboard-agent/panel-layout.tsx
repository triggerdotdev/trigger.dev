// Both class helpers apply to always-rendered wrappers, so toggling fullscreen is a
// class change only and the open chat's transport, session and transcript survive it.
import { cn } from "~/utils/cn";

const AGENT_FULLSCREEN_STORAGE_KEY = "tdev:dashboard-agent:fullscreen";

export function readAgentFullscreen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AGENT_FULLSCREEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeAgentFullscreen(fullscreen: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_FULLSCREEN_STORAGE_KEY, fullscreen ? "true" : "false");
  } catch {
    /* ignore */
  }
}

export function agentTakeoverClassName(fullscreen: boolean): string {
  return fullscreen ? "absolute inset-0 z-10 bg-background-bright" : "h-full";
}

// `invisible` rather than `display: none`: only this preserves the computed layout, so
// scroll positions and measured widths survive.
export function agentHiddenContentClassName(fullscreen: boolean): string {
  return cn("h-full overflow-hidden", fullscreen && "invisible");
}

export function AgentPanelColumn({
  fullscreen,
  children,
}: {
  fullscreen: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        fullscreen && "mx-auto w-full max-w-3xl"
      )}
    >
      {children}
    </div>
  );
}
