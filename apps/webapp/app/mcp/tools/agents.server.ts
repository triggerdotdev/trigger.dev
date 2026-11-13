import { $replica } from "~/db.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, textResult } from "./define.server";
import { subjectEnvironment } from "./query.server";
import { CommonProjectsInput } from "./schemas/common";

export const agentsTools: McpToolDefinition[] = [
  defineReadTool({
    name: "list_agents",
    title: "List Agents",
    description:
      "List all chat agents in the current worker. Agents are tasks created with chat.agent() or chat.customAgent(). Use start_agent_chat with an agent's slug to start a conversation.",
    shape: CommonProjectsInput.shape,
    auth: { action: "read", subject: "deployments" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const worker = await findCurrentWorkerFromEnvironment(environment, $replica, "current");
      if (!worker) return errorResult("Worker not found");

      const agents = await $replica.backgroundWorkerTask.findMany({
        where: { workerId: worker.id, triggerSource: "AGENT" },
        select: { slug: true, filePath: true },
        orderBy: { slug: "asc" },
      });

      if (agents.length === 0) {
        return textResult(
          `No agents found in the current worker (${worker.version}) for ${input.environment}. Agents are tasks created with chat.agent() or chat.customAgent().`
        );
      }

      const contents = [
        `Found ${agents.length} agent${agents.length === 1 ? "" : "s"} in worker ${worker.version} (${input.environment}):`,
        "",
      ];

      for (const agent of agents) {
        contents.push(
          `- **${fenceUntrusted(agent.slug, "agent-slug")}** (${fenceUntrusted(agent.filePath, "agent")})`
        );
      }

      contents.push("");
      contents.push(
        "Use `start_agent_chat` with an agent's slug as the `agentId` to start a conversation."
      );
      contents.push("Use `get_task_schema` with an agent's slug to see its payload schema.");

      return textResult(contents.join("\n"));
    },
  }),
];
