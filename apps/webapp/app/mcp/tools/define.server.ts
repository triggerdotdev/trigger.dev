import { z } from "zod";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requiresApproval } from "../gate/approval.server";
import type { McpToolAuth } from "../gate/types";
import {
  withMcpToolAuth,
  type McpToolContext,
  type McpToolResult,
} from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";

export const dashboardUrl = (path: string) => `${env.APP_ORIGIN}${path}`;

export function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: string): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
}

/** Parses args first so schema defaults (environment) reach the auth gate. */
export function defineReadTool<S extends z.ZodRawShape>(tool: {
  name: string;
  title: string;
  description: string;
  shape: S;
  auth: McpToolAuth;
  run: (input: z.output<z.ZodObject<S>>, ctx: McpToolContext) => Promise<McpToolResult>;
}): McpToolDefinition {
  const schema = z.object(tool.shape);
  const gated = withMcpToolAuth(tool.auth, tool.run, tool.name);

  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      title: tool.title,
    },
    confirm: requiresApproval(tool.auth) !== false,
    auth: tool.auth,
    handler: async (args, identity, request, extra) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.message}`);
      return gated(parsed.data, identity, request, extra);
    },
  };
}

export async function resolveToolEnvironment(ctx: McpToolContext) {
  const { projectId, environmentId } = ctx.subject ?? {};
  if (!projectId || !environmentId) return null;

  const environment = await findEnvironmentById(environmentId);
  return environment?.projectId === projectId ? environment : null;
}
