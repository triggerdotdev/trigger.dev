import { LazyLoadFailed, lazyWithRetry } from "~/components/primitives/LazyLoad";
import { Spinner } from "~/components/primitives/Spinner";

// The chat panel brings the AI SDK, markdown rendering, the alert forms and the company icon
// set. It only renders once the panel is opened, so it loads then (or on hover of the
// launcher) instead of holding up the first render of every environment page.
const loadPanel = () => import("./DashboardAgentPanel");

let preload: Promise<unknown> | undefined;

/** Start downloading the panel's code ahead of an open. Safe to call repeatedly. */
export function preloadDashboardAgentPanel() {
  preload ??= loadPanel().catch(() => {
    // A failed preload must not stop the real open from retrying.
    preload = undefined;
  });
}

export const LazyDashboardAgentPanel = lazyWithRetry(() =>
  loadPanel().then((module) => ({ default: module.DashboardAgentPanel }))
);

export function DashboardAgentPanelFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-background-bright">
      <Spinner className="size-5" />
    </div>
  );
}

/** The panel's code couldn't be loaded: the message sits where the panel would. */
export function DashboardAgentPanelLoadFailed() {
  return (
    <div className="flex h-full items-center justify-center bg-background-bright">
      <LazyLoadFailed />
    </div>
  );
}
