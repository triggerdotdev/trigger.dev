import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { classifyFailure as classifyFailureSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import { getRunForLLM } from "../runs/run-presenter-adapter";

const FailureClassificationSchema = z.object({
  category: z
    .enum([
      "Timeout",
      "OOM / Memory",
      "Missing env var",
      "Child task failed",
      "User code exception",
      "AI provider rate limit",
      "Deploy regression",
      "Platform issue",
      "Unknown",
    ])
    .describe("The category of failure"),
  confidence: z
    .enum(["High", "Medium", "Low"])
    .describe("How confident we are in this classification"),
  evidence: z.string().describe("The key evidence supporting this classification"),
  nextSteps: z
    .array(z.string())
    .describe("Suggested next steps for investigation or remediation"),
});

export function createClassifyFailureTool(ctx: ToolContext) {
  return tool({
    ...classifyFailureSchema,
    execute: async (params: { runFriendlyId: string }) => {
      try {
        // Fetch run details including logs
        const runWithTrace = await getRunForLLM(ctx, params.runFriendlyId);

        if (!runWithTrace) {
          return {
            category: "Unknown",
            confidence: "Low",
            evidence: "Could not fetch run details",
            nextSteps: [],
          };
        }

        const { run, trace } = runWithTrace;

        // Build a summary of the run for classification
        const runSummary = `
Run Status: ${run.status}
Duration: ${run.duration || "unknown"}
Started: ${run.startedAt || "unknown"}
Completed: ${run.completedAt || "unknown"}
Trace Summary: ${trace ? `${trace.totalSpans} spans, root status ${trace.rootStatus}` : "No trace data"}
`;

        // Use a cheaper model for classification
        const classification = await generateObject({
          model: openai("gpt-4o-mini"),
          schema: FailureClassificationSchema,
          prompt: `
Classify the cause of this task run failure based on the following information:

${runSummary}

Consider these categories:
- Timeout: Run exceeded max duration
- OOM / Memory: Out of memory or memory limit exceeded
- Missing env var: Missing required environment variable
- Child task failed: Subtask or dependent task failed
- User code exception: Exception in user's code
- AI provider rate limit: Hit rate limit from external AI service
- Deploy regression: Likely caused by a recent deployment
- Platform issue: Platform/infrastructure issue
- Unknown: Cannot determine the cause

Provide your classification with supporting evidence and next steps.
`,
        });

        return classification;
      } catch (error) {
        return {
          category: "Unknown",
          confidence: "Low",
          evidence: `Error during classification: ${error instanceof Error ? error.message : String(error)}`,
          nextSteps: ["Check the run logs manually in the dashboard"],
        };
      }
    },
  });
}
