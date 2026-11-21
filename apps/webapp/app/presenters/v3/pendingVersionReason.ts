// Plain words for why a run sits in Pending version. The engine records the cause as the run's
// statusReason when it parks the run; versions come from the environment as it is now.
export type PendingVersionReasonInput = {
  statusReason: string | undefined;
  taskIdentifier: string;
  queueName: string;
  /** The environment's current version (latest dev worker in dev), if any. */
  currentVersion: string | undefined;
  /** The newest version that had this task, when the current one doesn't. */
  previousVersion: string | undefined;
  lockedVersion: string | undefined;
  externalDeploymentId: string | undefined;
};

export type PendingVersionReason = {
  reason: string;
  releasedBy: string;
};

export function describePendingVersion(input: PendingVersionReasonInput): PendingVersionReason {
  const { taskIdentifier, queueName, currentVersion, previousVersion, lockedVersion } = input;
  // A locked run only ever runs on its locked version, so that is the version that lacks the task.
  const version = lockedVersion ?? currentVersion;
  const where = lockedVersion
    ? `version ${lockedVersion}`
    : currentVersion
      ? `the current version ${currentVersion}`
      : undefined;
  const releasedBy = lockedVersion
    ? `It's locked to version ${lockedVersion}, so a new deploy won't start it. Replay it to run it on another version.`
    : "Starts when a deploy includes this task.";

  switch (input.statusReason) {
    case "EXTERNAL_DEPLOYMENT_PENDING":
      return {
        reason: input.externalDeploymentId
          ? `Waiting for deployment ${input.externalDeploymentId}.`
          : "Waiting for a deployment to finish.",
        releasedBy: "Starts when that deployment finishes.",
      };
    case "QUEUE_NOT_FOUND":
      return {
        reason: where
          ? `Queue ${queueName} isn't in ${where}.`
          : `Queue ${queueName} isn't in any version yet.`,
        releasedBy: lockedVersion ? releasedBy : "Starts when a deploy includes this queue.",
      };
    case "TASK_NOT_IN_LATEST":
    case "TASK_NEVER_REGISTERED": {
      if (!where) {
        return { reason: "No deployment in this environment yet.", releasedBy };
      }
      const earlier =
        previousVersion && previousVersion !== version ? ` It was in ${previousVersion}.` : "";
      return { reason: `${taskIdentifier} isn't in ${where}.${earlier}`, releasedBy };
    }
    case "NO_DEPLOYMENT":
    case "NO_WORKER":
      return {
        reason: lockedVersion
          ? `Version ${lockedVersion} can't be found in this environment.`
          : currentVersion
            ? `No version in this environment could run it when it was queued.`
            : "No deployment in this environment yet.",
        releasedBy,
      };
    default:
      return {
        reason: "Waiting for a version that includes this run's task and queue.",
        releasedBy,
      };
  }
}
