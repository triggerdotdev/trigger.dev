import type { z } from "zod";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpConfirmSpec, McpToolAuth } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult } from "./define.server";

type WriteAuth = Extract<McpToolAuth, { action: string }>;

export function defineWriteTool<S extends z.ZodRawShape>(tool: {
  name: string;
  title: string;
  description: string;
  shape: S;
  auth: WriteAuth;
  confirm?: McpConfirmSpec<z.output<z.ZodObject<S>>>;
  run: (input: z.output<z.ZodObject<S>>, ctx: McpToolContext) => Promise<McpToolResult>;
}): McpToolDefinition {
  const { confirm, ...rest } = tool;

  return {
    ...defineReadTool({
      ...rest,
      auth: { ...tool.auth, confirm: (confirm as McpConfirmSpec | undefined) ?? true },
    }),
    annotations: { title: tool.title, readOnlyHint: false, destructiveHint: true },
  };
}

export const fencedError = (message: string, source: string) =>
  errorResult(fenceUntrusted(message, source));
