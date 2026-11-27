import {
  inputRequired,
  inputResponse,
  UrlElicitationRequiredError,
  type CallToolResult,
  type McpServer,
  type ProtocolEra,
  type ScopeChallengeHandler,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { MCP_SCOPES } from "~/services/oauth/metadata.server";
import type { McpRequestExtra, McpToolAuth } from "./gate/types";
import { missingScopes } from "./gate/withMcpToolAuth.server";
import { reportToolCall, type ReportToolCall } from "./gate/reportToolCall.server";
import {
  clientIdentityFromEnvelope,
  sessionHandling,
  toolCalledProperties,
  userAgentOf,
} from "./sessionTelemetry";
import type { McpIdentity } from "./types";
import { agentsTools } from "./tools/agents.server";
import { alertsTools } from "./tools/alerts.server";
import { batchesTools } from "./tools/batches.server";
import { bulkActionsTools } from "./tools/bulkActions.server";
import { dashboardsTools } from "./tools/dashboards.server";
import { dashboardsEditTools } from "./tools/dashboardsEdit.server";
import { dashboardsReadTools } from "./tools/dashboardsRead.server";
import { deploymentDetailsTools } from "./tools/deploymentDetails.server";
import { deploysTools } from "./tools/deploys.server";
import { environmentsTools } from "./tools/environments.server";
import { docsTools } from "./tools/docs.server";
import { envVarTools } from "./tools/envVars.server";
import { errorsTools } from "./tools/errors.server";
import { modelsTools } from "./tools/models.server";
import { orgsTools } from "./tools/orgs.server";
import { promptsTools } from "./tools/prompts.server";
import { promptsReadTools } from "./tools/promptsRead.server";
import { queryTools } from "./tools/query.server";
import { queuesTools } from "./tools/queues.server";
import { queuesWriteTools } from "./tools/queuesWrite.server";
import { reportTools } from "./tools/report.server";
import { logsTools } from "./tools/logs.server";
import { runsTools } from "./tools/runs.server";
import { runStreamsTools } from "./tools/runStreams.server";
import { schedulesTools } from "./tools/schedules.server";
import { sessionsTools } from "./tools/sessions.server";
import { sessionsReadTools } from "./tools/sessionsRead.server";
import { tasksTools } from "./tools/tasks.server";
import { taskListTools } from "./tools/tasksList.server";
import { webhooksTools } from "./tools/webhooks.server";
import { waitpointsTools } from "./tools/waitpoints.server";
import { webhooksReadTools } from "./tools/webhooksRead.server";
import { agentChatTools } from "./tools/agentChat.server";
import { alertsManageTools } from "./tools/alertsManage.server";
import { alertsWriteTools } from "./tools/alertsWrite.server";
import { batchTriggerTools } from "./tools/batchTrigger.server";
import { bulkActionsWriteTools } from "./tools/bulkActionsWrite.server";
import { dashboardsWriteTools } from "./tools/dashboardsWrite.server";
import { errorsWriteTools } from "./tools/errorsWrite.server";
import { feedbackTools } from "./tools/feedback.server";
import { orgsWriteTools } from "./tools/orgsWrite.server";
import { playgroundWriteTools } from "./tools/playgroundWrite.server";
import { promptsWriteTools } from "./tools/promptsWrite.server";
import { runsEditTools } from "./tools/runsEdit.server";
import { runsWriteTools } from "./tools/runsWrite.server";
import { schedulesWriteTools } from "./tools/schedulesWrite.server";
import { sessionsWriteTools } from "./tools/sessionsWrite.server";
import { tasksWriteTools } from "./tools/tasksWrite.server";
import { webhooksWriteTools } from "./tools/webhooksWrite.server";
import { webhooksEndpointWriteTools } from "./tools/webhooksEndpointWrite.server";
import { waitpointsWriteTools } from "./tools/waitpointsWrite.server";
import { webhooksWaiterWriteTools } from "./tools/webhooksWaiterWrite.server";
import { deploymentsWriteTools } from "./tools/deploymentsWrite.server";
import { environmentsWriteTools } from "./tools/environmentsWrite.server";

export type McpApprovalClass = "required" | "configurable" | "none";

export type McpToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
  /** The gate holds the call for user confirmation. */
  confirm?: boolean;
  approval?: McpApprovalClass;
  auth?: McpToolAuth;
  handler: (
    args: unknown,
    identity: McpIdentity,
    request: Request,
    extra?: McpRequestExtra
  ) => Promise<CallToolResult>;
};

export type McpToolContext = {
  identity: McpIdentity;
  request: Request;
  era: ProtocolEra;
  report?: ReportToolCall;
};

function assertUniqueToolNames(tools: McpToolDefinition[]) {
  const seen = new Set<string>();
  for (const { name } of tools) {
    if (seen.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
    seen.add(name);
  }
  return tools;
}

export const mcpTools: McpToolDefinition[] = assertUniqueToolNames([
  ...orgsTools,
  ...tasksTools,
  ...taskListTools,
  ...schedulesTools,
  ...runsTools,
  ...runStreamsTools,
  ...logsTools,
  ...errorsTools,
  ...bulkActionsTools,
  ...batchesTools,
  ...waitpointsTools,
  ...deploysTools,
  ...deploymentDetailsTools,
  ...envVarTools,
  ...environmentsTools,
  ...queryTools,
  ...dashboardsTools,
  ...dashboardsReadTools,
  ...modelsTools,
  ...promptsTools,
  ...promptsReadTools,
  ...agentsTools,
  ...sessionsTools,
  ...sessionsReadTools,
  ...alertsTools,
  ...webhooksTools,
  ...webhooksReadTools,
  ...reportTools,
  ...docsTools,
  ...agentChatTools,
  ...alertsWriteTools,
  ...alertsManageTools,
  ...dashboardsWriteTools,
  ...errorsWriteTools,
  ...dashboardsEditTools,
  ...feedbackTools,
  ...orgsWriteTools,
  ...playgroundWriteTools,
  ...promptsWriteTools,
  ...runsWriteTools,
  ...runsEditTools,
  ...bulkActionsWriteTools,
  ...sessionsWriteTools,
  ...tasksWriteTools,
  ...batchTriggerTools,
  ...schedulesWriteTools,
  ...webhooksWriteTools,
  ...webhooksEndpointWriteTools,
  ...webhooksWaiterWriteTools,
  ...waitpointsWriteTools,
  ...deploymentsWriteTools,
  ...environmentsWriteTools,
  ...queuesTools,
  ...queuesWriteTools,
]);

export function registerMcpTools(
  server: McpServer,
  tools: McpToolDefinition[],
  ctx: McpToolContext
) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.inputSchema),
        annotations: tool.annotations,
        scopeChallenge:
          ctx.era === "modern" && tool.auth
            ? scopeChallengeFor(tool.name, tool.auth, ctx, Object.keys(tool.inputSchema))
            : undefined,
      },
      async (args: unknown, extra) => {
        try {
          return await tool.handler(args, ctx.identity, ctx.request, {
            signal: extra.mcpReq.signal,
            requestId: extra.mcpReq.id,
            era: ctx.era,
            client:
              ctx.era === "modern" ? clientIdentityFromEnvelope(extra.mcpReq.envelope) : undefined,
          });
        } catch (error) {
          if (ctx.era === "modern" && error instanceof UrlElicitationRequiredError) {
            const response = inputResponse(
              extra.mcpReq.inputResponses,
              error.elicitations[0].elicitationId
            );
            if (response.kind === "elicit" && response.action !== "accept") {
              return confirmationToolError(error);
            }
            return server.server.getClientCapabilities()?.elicitation?.url
              ? urlElicitationInputRequired(error)
              : confirmationToolError(error);
          }
          throw error;
        }
      }
    );
  }
}

// The call is rejected before validation, so only names the tool declares are reported.
function pickKeys(args: unknown, allowed: string[]) {
  if (typeof args !== "object" || args === null) return undefined;
  return Object.fromEntries(Object.entries(args).filter(([key]) => allowed.includes(key)));
}

function scopeChallengeFor(
  tool: string,
  auth: McpToolAuth,
  ctx: McpToolContext,
  schemaKeys: string[]
): ScopeChallengeHandler {
  const { identity } = ctx;
  return ({ request: rpc }) => {
    const [first, ...rest] = missingScopes(auth, identity);
    if (!first || identity.kind !== "uat") return undefined;
    const handling = sessionHandling(ctx.era, ctx.request.headers);
    (ctx.report ?? reportToolCall)({
      userId: identity.userId,
      properties: toolCalledProperties({
        mcpSessionId: handling.mcpSessionId,
        tool,
        outcome: "insufficient_scope",
        durationMs: 0,
        args: pickKeys(rpc.params?.arguments, schemaKeys),
        denyReason: "scope",
        tokenKind: identity.kind,
        clientId: identity.clientId,
        userAgent: userAgentOf(ctx.request.headers),
        client: clientIdentityFromEnvelope(rpc.params?._meta),
      }),
      stitch: handling.stitch
        ? {
            client: clientIdentityFromEnvelope(rpc.params?._meta),
            userAgent: userAgentOf(ctx.request.headers),
          }
        : undefined,
    });
    logger.info("mcp.tool", {
      userId: identity.userId,
      tokenKind: identity.kind,
      tokenId: identity.sourceTokenId,
      clientId: identity.clientId,
      tool,
      outcome: "insufficient_scope",
      denyReason: "scope",
    });
    const held = (identity.cap ?? []).filter((s) => MCP_SCOPES.includes(s));
    return { scopes: [...new Set([...held, first, ...rest])] as [string, ...string[]] };
  };
}

function urlElicitationInputRequired(error: UrlElicitationRequiredError) {
  const [{ elicitationId, url, message }] = error.elicitations;
  return inputRequired({
    inputRequests: { [elicitationId]: inputRequired.elicitUrl({ url, message }) },
  });
}

// -32042 cannot be sent on 2026-07-28, so clients without URL elicitation get the tool-error shape.
function confirmationToolError(error: UrlElicitationRequiredError): CallToolResult {
  return { content: [{ type: "text", text: error.elicitations[0].message }], isError: true };
}
