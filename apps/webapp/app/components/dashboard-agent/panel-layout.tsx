/**
 * The agent panel's two shapes: the side panel and the fullscreen takeover.
 *
 * Fullscreen is a takeover, not a modal and not a route: the dashboard's side
 * nav stays where it is and the panel expands to fill everything right of it.
 * That means the page underneath is *hidden*, never unmounted — leaving the page
 * would throw away its filters, scroll position and any in-flight loader data,
 * and coming back would refetch all of it. `agentTakeoverClassName` and
 * `agentHiddenContentClassName` are the two halves of that: the panel floats
 * over the content area, the content stays mounted and inert behind it.
 *
 * Both classes are applied to wrappers that are always rendered, so toggling
 * fullscreen changes class names only. Nothing in the panel's subtree remounts,
 * which is what keeps the open chat's transport, session and transcript alive
 * across the toggle.
 */
import { cn } from "~/utils/cn";

/**
 * Remembered per browser, like the panel's last-open chat: someone who works
 * fullscreen gets fullscreen the next time they open the panel.
 */
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
 * The panel's own wrapper. In fullscreen it is lifted out of the resizable split
 * and pinned over the whole content area; otherwise it just fills its panel.
 */
export function agentTakeoverClassName(fullscreen: boolean): string {
  return fullscreen ? "absolute inset-0 z-10 bg-background-bright" : "h-full";
}

/**
 * The page content behind a takeover. `invisible` rather than `display: none`:
 * both keep it mounted, but only this one preserves the layout it has already
 * computed, so scroll positions and measured widths survive the round trip.
 * Invisible content is also inert to clicks and to the tab order.
 */
export function agentHiddenContentClassName(fullscreen: boolean): string {
  return cn("h-full overflow-hidden", fullscreen && "invisible");
}

/**
 * The panel's content column: the transcript, the composer and the blank-state
 * hero. Full width in the side panel; in fullscreen it is capped and centred, so
 * a line of an answer stays a readable length instead of running the width of a
 * monitor.
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
