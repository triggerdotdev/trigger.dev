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
