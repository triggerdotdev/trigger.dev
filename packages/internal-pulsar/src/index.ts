const TENANT = process.env.PULSAR_TENANT || "public";
const WORKFLOWS_NAMESPACE = process.env.PULSAR_WORKFLOWS_NAMESPACE || "default";
const QUEUES_NAMESPACE = process.env.PULSAR_QUEUES_NAMESPACE || "default";

export const Topics = {
  triggers: `persistent://${TENANT}/${WORKFLOWS_NAMESPACE}/triggers`,
  runCommands: `persistent://${TENANT}/${WORKFLOWS_NAMESPACE}/run-commands`,
  runCommandResponses: `persistent://${TENANT}/${WORKFLOWS_NAMESPACE}/run-command-responses`,
  integrationWorker: `persistent://${TENANT}/${QUEUES_NAMESPACE}/integration-requests`,
  appTaskWorker: `persistent://${TENANT}/${QUEUES_NAMESPACE}/background-tasks`,
  appEventQueue: `persistent://${TENANT}/${QUEUES_NAMESPACE}/webapp-events`,
};
