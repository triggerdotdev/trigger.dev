import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import type { McpContext } from "./context.js";
import { GetReportInput } from "./schemas.js";

// Derived from the tool's schema so completion can't drift from what get_report accepts.
// `environment` has a `.default(...)`, so read its enum through `removeDefault()`.
const REPORT_KEYS = GetReportInput.shape.key.options;
const ENVIRONMENTS = GetReportInput.shape.environment.removeDefault().options;

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
      argsSchema: {
        key: completable(z.string().optional(), (value) =>
          REPORT_KEYS.filter((k) => k.startsWith(value ?? ""))
        ),
        environment: completable(z.string().optional(), (value) =>
          ENVIRONMENTS.filter((e) => e.startsWith(value ?? ""))
        ),
        // Plain string on purpose: MCP prompt args must be simple string schemas (the SDK
        // introspects them as such), and this only forwards into get_report, which validates
        // the period with the shared ReportPeriodSchema. Don't swap in a refined schema here.
        period: z.string().optional(),
      },
    },
    async ({ key, environment, period }) => {
      const reportKey = key || "health";
      const env = environment || (context.options.devOnly ? "dev" : "prod");

      const args = [`key: "${reportKey}"`, `environment: "${env}"`];
      if (period) {
        args.push(`period: "${period}"`);
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Fetch the ${reportKey} report by calling the get_report tool with { ${args.join(
                ", "
              )} } (add projectRef if this workspace has more than one Trigger.dev project).

Show the returned report to the user EXACTLY as-is, inside a fenced code block: it is monospace-aligned with unicode sparklines, so do not paraphrase, reformat, translate, or trim whitespace.

After the block, add at most two sentences of your own — and only if the report's recommended action intersects with something you know about this project (for example, where the relevant configuration lives). Otherwise add nothing.`,
            },
          },
        ],
      };
    }
  );
}
