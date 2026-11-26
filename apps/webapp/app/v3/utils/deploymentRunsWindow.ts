const DAY_MS = 24 * 60 * 60 * 1000;

/** Where to look for a version's runs, in epoch milliseconds. No `to` means up to now. */
export type DeploymentRunsWindow = { from: number; to?: number };

/**
 * The time range the deployment page lists a version's runs in. Runs queued up to a day before
 * the deploy can still run on it, and nearly all new runs stop arriving once the next deploy takes
 * over, so the range ends a day after that deploy. The current version, and one with no deploy
 * after it, has no end.
 *
 * The end keeps an old version's page from reading every run the environment has had since. It
 * isn't exact: runs locked to the version (a child of an older run, a replay on the original
 * version) and runs from a time the version was rolled back to can be created later. The page
 * says where its list ends, and its links to the runs list carry only `from`.
 */
export function deploymentRunsWindow({
  startedAt,
  nextDeployedAt,
  isCurrent,
}: {
  /** When this version was deployed, or created if it never was. */
  startedAt: Date;
  /** When the next deploy in the environment went live, if there is one. */
  nextDeployedAt?: Date | null;
  isCurrent: boolean;
}): DeploymentRunsWindow {
  const start = startedAt.getTime();
  const from = start - DAY_MS;
  if (isCurrent || !nextDeployedAt) return { from };
  return { from, to: Math.max(nextDeployedAt.getTime(), start) + DAY_MS };
}
