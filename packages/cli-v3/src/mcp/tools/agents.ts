import { toolsMetadata } from "../config.js";
import { CommonProjectsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

export const listAgentsTool = {
  name: toolsMetadata.list_agents.name,
  title: toolsMetadata.list_agents.title,
  description: toolsMetadata.list_agents.description,
  inputSchema: CommonProjectsInput.shape,
  handler: toolHandler(CommonProjectsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling list_agents", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient(input.branch);

    const workerResult = await cliApiClient.getWorkerByTag(
      projectRef,
      input.environment,
      "current"
    );

    if (!workerResult.success) {
      return respondWithError(workerResult.error);
    }

    const { worker } = workerResult.data;
    const agents = worker.tasks.filter((t) => t.triggerSource === "AGENT");

    if (agents.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No agents found in the current worker (${worker.version}) for ${input.environment}. Agents are tasks created with chat.agent() or chat.customAgent().`,
          },
        ],
      };
    }

    const contents = [
      `Found ${agents.length} agent${agents.length === 1 ? "" : "s"} in worker ${worker.version} (${input.environment}):`,
      "",
    ];

    for (const agent of agents) {
      contents.push(`- **${agent.slug}** (${agent.filePath})`);
    }

    contents.push("");
    contents.push(
      "Use `start_agent_chat` with an agent's slug as the `agentId` to start a conversation."
    );
    contents.push(
      "Use `get_task_schema` with an agent's slug to see its payload schema."
    );

    return {
      content: [{ type: "text", text: contents.join("\n") }],
    };
  }),
};
