import parseDuration from "parse-duration";
import { $replica } from "~/db.server";
import { AgentDetailPresenter } from "~/presenters/v3/AgentDetailPresenter.server";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { TaskDetailPresenter } from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, resolveToolEnvironment, textResult } from "./define.server";
import {
  agentNotFound,
  deploymentNotFound,
  formatAgentDetails,
  formatDeploymentDetails,
} from "./format/deployments";
import { plainError } from "./format/insights";
import { startReadBudget } from "./readBudget.server";
import { GetAgentDetailsInput, GetDeploymentDetailsInput } from "./schemas/deploymentDetails";

const ACTIVITY_BUDGET_MS = 15_000;
const DEPLOYMENT_BUDGET_MS = 10_000;

const DEPLOYMENT_TIMEOUT = "Reading the deployment took too long. Try again later.";

const AGENT_TIMEOUT = "Reading the agent took too long. Try again later.";

const ACTIVITY_TIMEOUT =
  "Reading the agent's activity took too long. Try again with a shorter period.";

const CANCELLED = "The request was cancelled before it finished.";

const stoppedResult = (read: { reason: "aborted" | "timeout" }, timeout: string) =>
  plainError(read.reason === "aborted" ? CANCELLED : timeout);

export function createDeploymentDetailsTools({
  activityBudgetMs = ACTIVITY_BUDGET_MS,
  deploymentBudgetMs = DEPLOYMENT_BUDGET_MS,
}: { activityBudgetMs?: number; deploymentBudgetMs?: number } = {}): McpToolDefinition[] {
  const getDeploymentDetails = defineReadTool({
    name: "get_deployment_details",
    title: "Get Deployment Details",
    description:
      "Get one deployment as the dashboard's deployment page shows it: status, version, timings, error, git metadata, who deployed it and the tasks it contains. Pass the deployment_ id or the short code from list_deploys.",
    shape: GetDeploymentDetailsInput.shape,
    auth: { action: "read", subject: "deployments" },
    run: async (input, ctx) => {
      const { read } = startReadBudget(deploymentBudgetMs, ctx.signal);
      const resolved = await read(() => resolveToolEnvironment(ctx));
      if (!resolved.ok) return stoppedResult(resolved, DEPLOYMENT_TIMEOUT);
      const environment = resolved.value;
      if (!environment) return plainError("Environment not found");

      const found = await read(() =>
        $replica.workerDeployment.findFirst({
          where: {
            environmentId: environment.id,
            ...(input.deploymentId.startsWith("deployment_")
              ? { friendlyId: input.deploymentId }
              : { shortCode: input.deploymentId }),
          },
          select: { shortCode: true },
        })
      );
      if (!found.ok) return stoppedResult(found, DEPLOYMENT_TIMEOUT);
      const shortCode = found.value?.shortCode;
      if (!shortCode) return deploymentNotFound(input.deploymentId);

      const page = await read(() =>
        new DeploymentPresenter().call({
          userId: ctx.identity.userId,
          organizationSlug: environment.organization.slug,
          projectSlug: environment.project.slug,
          environmentSlug: environment.slug,
          deploymentShortCode: shortCode,
          withEventStream: false,
        })
      );
      if (!page.ok) return stoppedResult(page, DEPLOYMENT_TIMEOUT);
      if (!page.value) return deploymentNotFound(input.deploymentId);

      return textResult(formatDeploymentDetails(page.value.deployment));
    },
  });

  const getAgentDetails = defineReadTool({
    name: "get_agent_details",
    title: "Get Agent Details",
    description:
      "Get one chat agent as the dashboard's agent page shows it: its file, config, and its activity over a period (runs and sessions by status, LLM cost and tokens). Use list_agents to find the slug.",
    shape: GetAgentDetailsInput.shape,
    auth: { action: "read", subject: "deployments" },
    run: async (input, ctx) => {
      const { read, limit } = startReadBudget(activityBudgetMs, ctx.signal);
      const resolved = await read(() => resolveToolEnvironment(ctx));
      if (!resolved.ok) return stoppedResult(resolved, AGENT_TIMEOUT);
      const environment = resolved.value;
      if (!environment) return plainError("Environment not found");

      const store = await read(() =>
        clickhouseFactory.getClickhouseForOrganization(environment.organizationId, "standard")
      );
      if (!store.ok) return stoppedResult(store, AGENT_TIMEOUT);
      const tasks = new TaskDetailPresenter($replica, store.value);
      const agents = new AgentDetailPresenter(store.value);
      const found = await read(() =>
        tasks.findTask({
          projectId: environment.projectId,
          environmentId: environment.id,
          environmentType: environment.type,
          taskSlug: input.agentSlug,
          expectedTriggerSource: "AGENT",
        })
      );
      if (!found.ok) return stoppedResult(found, AGENT_TIMEOUT);
      const agent = found.value;
      if (!agent) return agentNotFound(input.agentSlug);

      const to = new Date();
      const from = new Date(to.getTime() - parseDuration(input.period)!);
      const scope = {
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        agentSlug: agent.slug,
        from,
        to,
        limit: limit(),
      };
      // Each section needs the right its standalone tool needs; a section the caller may not see is not read.
      const mayRead = (subject: "runs" | "sessions" | "query") =>
        ctx.ability?.can("read", { type: subject, envType: environment.type }) ?? false;

      const activity = await read(() =>
        Promise.all([
          mayRead("runs") ? tasks.getActivity({ ...scope, taskSlug: agent.slug }) : undefined,
          mayRead("sessions") ? agents.getSessionActivity(scope) : undefined,
          mayRead("query") ? agents.getLlmCostActivity(scope) : undefined,
          mayRead("query") ? agents.getLlmTokenActivity(scope) : undefined,
        ])
      );
      if (!activity.ok) return stoppedResult(activity, ACTIVITY_TIMEOUT);

      const [runs, sessions, cost, tokens] = activity.value;
      return textResult(formatAgentDetails(agent, input.period, { runs, sessions, cost, tokens }));
    },
  });

  return [getDeploymentDetails, getAgentDetails];
}

export const deploymentDetailsTools: McpToolDefinition[] = createDeploymentDetailsTools();
