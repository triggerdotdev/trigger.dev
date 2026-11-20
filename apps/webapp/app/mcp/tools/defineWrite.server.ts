import type { z } from "zod";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpConfirmSpec, McpToolAuth } from "../gate/types";
import { markStale, type McpToolContext, type McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpApprovalClass, McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult } from "./define.server";

type WriteAuth = Extract<McpToolAuth, { action: string }>;

export function defineWriteTool<S extends z.ZodRawShape>(tool: {
  name: string;
  title: string;
  description: string;
  shape: S;
  auth: WriteAuth;
  approval: McpApprovalClass;
  confirm?: McpConfirmSpec<z.output<z.ZodObject<S>>>;
  run: (input: z.output<z.ZodObject<S>>, ctx: McpToolContext) => Promise<McpToolResult>;
}): McpToolDefinition {
  const { confirm, approval, ...rest } = tool;

  return {
    ...defineReadTool({
      ...rest,
      auth: { ...tool.auth, confirm: (confirm as McpConfirmSpec | undefined) ?? true },
    }),
    annotations: { title: tool.title, readOnlyHint: false, destructiveHint: true },
    approval,
  };
}

export const fencedError = (message: string, source: string) =>
  errorResult(fenceUntrusted(message, source));

export function staleApproval(ctx: McpToolContext, rebuilt: string): McpToolResult | undefined {
  if (!ctx.confirmation || ctx.confirmation.preview === rebuilt) return undefined;
  return markStale(
    errorResult(
      "What this change would do has changed since it was approved. Call the tool again to get a new confirmation."
    )
  );
}
