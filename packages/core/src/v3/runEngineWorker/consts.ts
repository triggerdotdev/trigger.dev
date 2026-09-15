export const WORKER_HEADERS = {
  INSTANCE_NAME: "x-trigger-worker-instance-name",
  DEPLOYMENT_ID: "x-trigger-worker-deployment-id",
  MANAGED_SECRET: "x-trigger-worker-managed-secret",
  RUNNER_ID: "x-trigger-worker-runner-id",
  // Verified environment id recovered from the deployment token. Set by the supervisor only when
  // enforcing; the platform scopes the worker-action's snapshot read by it.
  ENVIRONMENT_ID: "x-trigger-worker-environment-id",
};

export const WORKLOAD_HEADERS = {
  DEPLOYMENT_ID: "x-trigger-workload-deployment-id",
  RUNNER_ID: "x-trigger-workload-runner-id",
  DEPLOYMENT_VERSION: "x-trigger-workload-deployment-version",
  PROJECT_REF: "x-trigger-workload-project-ref",
};
