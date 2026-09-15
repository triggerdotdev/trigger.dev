import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import type { McpContext } from "./context.js";
import { GetReportInput, ReportPeriodSchema } from "./schemas.js";

// Derived from the tool's schema so completion can't drift from what get_report accepts.
// `environment` has a `.default(...)`, so its enum is read through `removeDefault()`.
const ReportKeySchema = GetReportInput.shape.key;
const ReportEnvironmentSchema = GetReportInput.shape.environment.removeDefault();
const REPORT_KEYS = ReportKeySchema.options;
const ENVIRONMENTS = ReportEnvironmentSchema.options;

/** The same schemas the tool uses, so a bad key is rejected here rather than by get_report. */
export const ReportPromptArgs = z.object({
  key: ReportKeySchema.optional(),
  environment: ReportEnvironmentSchema.optional(),
  period: ReportPeriodSchema.optional(),
});

export type ReportPromptArgs = z.input<typeof ReportPromptArgs>;

/** Values go through `JSON.stringify` so a quote or newline can't close the snippet. */
export function formatToolArgs(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
    .join(", ");
}

/** Build the prompt text, rejecting arguments `get_report` would not accept. */
export function buildReportPromptText(
  rawArgs: ReportPromptArgs,
  options: { devOnly?: boolean } = {}
): string {
  const { key, environment, period } = ReportPromptArgs.parse(rawArgs);

  const reportKey = key ?? "health";
  const env = environment ?? (options.devOnly ? "dev" : "prod");

  const args: Record<string, string> = { key: reportKey, environment: env };
  if (period) {
    args.period = period;
  }

  return `Fetch the ${reportKey} report by calling the get_report tool with { ${formatToolArgs(
    args
  )} } (add projectRef if this workspace has more than one Trigger.dev project).

Show the returned report to the user EXACTLY as-is, inside a fenced code block: it is monospace-aligned with unicode sparklines, so do not paraphrase, reformat, translate, or trim whitespace.

After the block, add at most two sentences of your own — and only if the report's recommended action intersects with something you know about this project (for example, where the relevant configuration lives). Otherwise add nothing.`;
}

/**
 * MCP prompts surface as slash commands in hosts that support them (Claude Code renders
 * this as /mcp__trigger__report), so `/report health` is a real command — no per-project
 * files needed.
 */
export function registerPrompts(context: McpContext) {
  context.server.registerPrompt(
    "report",
    {
      title: "Report",
      description:
        "Render an interpreted report for an environment. Currently: 'health' — is work flowing, is it your code, is the data fresh.",
      // Enum and refined schemas, not bare strings, so the host rejects a bad value first.
      argsSchema: {
        key: completable(ReportKeySchema.optional(), (value) =>
          REPORT_KEYS.filter((k) => k.startsWith(value ?? ""))
        ),
        environment: completable(ReportEnvironmentSchema.optional(), (value) =>
          ENVIRONMENTS.filter((e) => e.startsWith(value ?? ""))
        ),
        period: ReportPeriodSchema.optional(),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: buildReportPromptText(args, { devOnly: context.options.devOnly }),
          },
        },
      ],
    })
  );
}
