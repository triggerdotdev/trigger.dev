import type { McpContext } from "./context.js";
import { deployTool, listDeploysTool } from "./tools/deploys.js";
import { searchDocsTool } from "./tools/docs.js";
import { submitFeedbackTool } from "./tools/feedback.js";
import {
  createProjectInOrgTool,
  initializeProjectTool,
  listOrgsTool,
  listProjectsTool,
} from "./tools/orgs.js";
import {
  createDashboardTool,
  listDashboardsTool,
  runDashboardQueryTool,
  setDashboardWidgetsTool,
} from "./tools/dashboards.js";
import { startDevServerTool, stopDevServerTool, devServerStatusTool } from "./tools/devServer.js";
import { listPreviewBranchesTool } from "./tools/previewBranches.js";
import { listProfilesTool, switchProfileTool, whoamiTool } from "./tools/profiles.js";
import { getQuerySchemaTool, queryTool } from "./tools/query.js";
import { getReportTool } from "./tools/report.js";
import {
  cancelRunTool,
  getRunDetailsTool,
  getSpanDetailsTool,
  listRunsTool,
  replayRunTool,
  waitForRunToCompleteTool,
} from "./tools/runs.js";
import { getCurrentWorker, getTaskSchemaTool, triggerTaskTool } from "./tools/tasks.js";
import {
  listPromptsTool,
  getPromptVersionsTool,
  promotePromptVersionTool,
  createPromptOverrideTool,
  updatePromptOverrideTool,
  removePromptOverrideTool,
  reactivatePromptOverrideTool,
} from "./tools/prompts.js";
import { listAgentsTool } from "./tools/agents.js";
import { startAgentChatTool, sendAgentMessageTool, closeAgentChatTool } from "./tools/agentChat.js";
import { readSessionChannelTool, writeSessionChannelTool } from "./tools/sessionChannels.js";
import {
  createAlertTool,
  listAlertCapabilitiesTool,
  listAlertsTool,
  resolveAlertTool,
} from "./tools/alerts.js";
import {
  generateWebhookSecretTool,
  getWebhookDeliveryTool,
  getWebhookEndpointDetailsTool,
  listWebhookDeliveriesTool,
  listWebhookEndpointsTool,
  replayWebhookDeliveryTool,
  setWebhookSecretTool,
} from "./tools/webhooks.js";
import { respondWithError } from "./utils.js";
import { isTelemetryEnabled } from "./telemetry.js";

/** Tool names that perform write/mutating operations. */
const WRITE_TOOLS = new Set([
  deployTool.name,
  triggerTaskTool.name,
  cancelRunTool.name,
  replayRunTool.name,
  createProjectInOrgTool.name,
  initializeProjectTool.name,
  promotePromptVersionTool.name,
  createPromptOverrideTool.name,
  updatePromptOverrideTool.name,
  removePromptOverrideTool.name,
  reactivatePromptOverrideTool.name,
  startAgentChatTool.name,
  sendAgentMessageTool.name,
  closeAgentChatTool.name,
  writeSessionChannelTool.name,
  createAlertTool.name,
  resolveAlertTool.name,
  generateWebhookSecretTool.name,
  setWebhookSecretTool.name,
  replayWebhookDeliveryTool.name,
  submitFeedbackTool.name,
  createDashboardTool.name,
  setDashboardWidgetsTool.name,
]);

export function registerTools(context: McpContext) {
  const tools = [
    searchDocsTool,
    submitFeedbackTool,
    listOrgsTool,
    listProjectsTool,
    createProjectInOrgTool,
    initializeProjectTool,
    getCurrentWorker,
    getTaskSchemaTool,
    triggerTaskTool,
    listRunsTool,
    getRunDetailsTool,
    getSpanDetailsTool,
    waitForRunToCompleteTool,
    cancelRunTool,
    replayRunTool,
    deployTool,
    listDeploysTool,
    listPreviewBranchesTool,
    getQuerySchemaTool,
    queryTool,
    listDashboardsTool,
    runDashboardQueryTool,
    createDashboardTool,
    setDashboardWidgetsTool,
    whoamiTool,
    listProfilesTool,
    switchProfileTool,
    startDevServerTool,
    stopDevServerTool,
    devServerStatusTool,
    listPromptsTool,
    getPromptVersionsTool,
    promotePromptVersionTool,
    createPromptOverrideTool,
    updatePromptOverrideTool,
    removePromptOverrideTool,
    reactivatePromptOverrideTool,
    listAgentsTool,
    startAgentChatTool,
    sendAgentMessageTool,
    closeAgentChatTool,
    readSessionChannelTool,
    writeSessionChannelTool,
    getReportTool,
    listAlertCapabilitiesTool,
    listAlertsTool,
    createAlertTool,
    resolveAlertTool,
    listWebhookEndpointsTool,
    getWebhookEndpointDetailsTool,
    listWebhookDeliveriesTool,
    getWebhookDeliveryTool,
    replayWebhookDeliveryTool,
    generateWebhookSecretTool,
    setWebhookSecretTool,
  ];

  for (const tool of tools) {
    // In readonly mode, skip write tools entirely so the LLM never sees them
    if (context.options.readonly && WRITE_TOOLS.has(tool.name)) {
      continue;
    }

    // Nothing to report to, so don't show the model a tool that can only fail.
    if (tool.name === submitFeedbackTool.name && !isTelemetryEnabled(context.options)) {
      continue;
    }

    const isWrite = WRITE_TOOLS.has(tool.name);

    context.server.registerTool(
      tool.name,
      {
        annotations: {
          title: tool.title,
          readOnlyHint: !isWrite,
          destructiveHint: isWrite,
        },
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input, extra) => {
        try {
          // await so a rejected async handler (e.g. a network failure in get_report) is caught
          // here and wrapped, not surfaced as an unhandled rejection.
          return await tool.handler(input, { ...extra, ctx: context });
        } catch (error) {
          return respondWithError(error);
        }
      }
    );
  }
}
