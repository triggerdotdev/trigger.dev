import { pendingNavigateIntents } from "./pending-intents";

/**
 * The panel follows the user around the dashboard, so a turn can outlive the page it was asked
 * on. Its navigation applies only there: someone who has since walked to another screen keeps
 * the screen they chose, and the answer's own button is still theirs to click.
 */
export function navigateIntentApplies(paths: {
  /** Null when this tab never saw the turn start, so it cannot claim the user is still there. */
  startedPath: string | null;
  currentPath: string;
}): boolean {
  return paths.startedPath === paths.currentPath;
}

type NavigateIntent = ReturnType<typeof pendingNavigateIntents>[number];

/**
 * The navigation to take on this commit, if any. Every intent is marked handled whether or not
 * it applies, so one dropped here cannot fire on a later commit.
 */
export function takeNavigateIntent(args: {
  messages: Parameters<typeof pendingNavigateIntents>[0];
  handled: Set<string>;
  startedPath: string | null;
  currentPath: string;
}): NavigateIntent | undefined {
  const target = pendingNavigateIntents(args.messages, args.handled).at(-1);
  if (!target) return undefined;
  return navigateIntentApplies({ startedPath: args.startedPath, currentPath: args.currentPath })
    ? target
    : undefined;
}
