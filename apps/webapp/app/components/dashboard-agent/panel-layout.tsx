/**
 * The agent panel's two shapes: the side panel and the fullscreen takeover.
 *
 * Fullscreen is a takeover, not a modal and not a route. The page underneath is
 * hidden, never unmounted, so its filters, scroll position and loader data survive.
 * Both class helpers apply to wrappers that are always rendered, so toggling
 * fullscreen changes class names only and nothing in the panel's subtree remounts:
 * that is what keeps the open chat's transport, session and transcript alive.
 */
import { cn } from "~/utils/cn";

/** Remembered per browser, like the panel's last-open chat. */
export const AGENT_FULLSCREEN_STORAGE_KEY = "tdev:dashboard-agent:fullscreen";

export function readAgentFullscreen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AGENT_FULLSCREEN_STORAGE_KEY) === "true";
  } catch {
    return false; // localStorage unavailable — the side panel is the default
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

/**
 * The panel's own wrapper. In fullscreen it is pinned over the whole content area;
 * otherwise it fills its panel.
 */
export function agentTakeoverClassName(fullscreen: boolean): string {
  return fullscreen ? "absolute inset-0 z-10 bg-background-bright" : "h-full";
}

/**
 * The page content behind a takeover. `invisible` rather than `display: none`: both
 * keep it mounted, but only this one preserves the computed layout, so scroll
 * positions and measured widths survive the round trip.
 */
export function agentHiddenContentClassName(fullscreen: boolean): string {
  return cn("h-full overflow-hidden", fullscreen && "invisible");
}

/**
 * The panel's content column. Full width in the side panel; capped and centred in
 * fullscreen, so a line of an answer stays a readable length.
 */
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
