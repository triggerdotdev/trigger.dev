import { anthropic } from "@ai-sdk/anthropic";
import {
  createDashboardAgentDb,
  insertTurnEval,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { logger, task } from "@trigger.dev/sdk";
import { generateObject } from "ai";
import { z } from "zod";

/**
 * Runtime eval. The dashboard agent triggers this from `onTurnComplete` after
 * every turn (decoupled task, idempotency-keyed, so it never blocks or bills the
 * agent run). One LLM-judge call produces both a quality verdict (did the agent
 * answer well, grounded in its tool results) and an insight classification
 * (intent, outcome, sentiment, and whether the turn exposes a product / docs /
 * support gap), then writes one `chat_turn_evals` row. Higher-level views ("top
 * capability gaps", "what users struggle with") are aggregations over those rows.
 */

const JUDGE_MODEL = "claude-sonnet-4-6";

// One connection pool per worker process for the eval task (separate from the
// agent's; eval runs are their own runs and may land on other workers).
let dbClient: DashboardAgentDbClient | undefined;
function getEvalDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString =
      process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the eval task");
    }
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

/** What `onTurnComplete` hands the eval task. */
export type EvalTurnPayload = {
  chatId: string;
  turn: number;
  agentRunId?: string;
  organizationId: string;
  userId: string;
  projectRef?: string;
  environment?: string;
  currentPage?: string;
  model?: string;
  promptSlug?: string;
  promptVersion?: number;
  /** The user's question this turn. */
  userText: string;
  /** The agent's answer this turn. */
  assistantText: string;
  /** Tools the agent called this turn, with inputs and outputs (the judge's ground truth). */
  toolActivity: Array<{ toolName: string; input?: unknown; output?: unknown }>;
};

const SIGNAL_TYPES = [
  "missing_tool",
  "missing_data",
  "permission_blocked",
  "docs_gap",
  "feature_request",
  "confusing_ux",
  "hallucination",
  "repeated_question",
] as const;

// Combined quality + insight verdict. Reasoning first (so the judge thinks
// before it scores), then the scores and classification.
const TurnEval = z.object({
  reasoning: z.string().describe("One or two sentences of reasoning, BEFORE the scores."),
  // Quality, 1-5.
  grounded: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Does the answer use only facts from the tool results? Penalize invented ids/counts/status. 5 = fully grounded."),
  answered: z.number().int().min(1).max(5).describe("Does it directly answer the question? 5 = fully."),
  concise: z.number().int().min(1).max(5).describe("Direct, no padding. Do not reward length."),
  // Insight classification.
  intentCategory: z
    .enum(["debug_run", "find_data", "how_to", "config", "capability_request", "billing", "other"])
    .describe("What the user was trying to do."),
  outcome: z
    .enum(["resolved", "partial", "unresolved", "deflected"])
    .describe("Did the agent actually help? deflected = sent the user elsewhere without answering."),
  sentiment: z.enum(["positive", "neutral", "negative", "frustrated"]),
  capabilityGap: z
    .boolean()
    .describe("The agent lacked a tool, data, or permission needed to fully help."),
  docsGap: z.boolean().describe("A how-to the agent answered weakly or that better docs would solve."),
  supportOpportunity: z
    .boolean()
    .describe("The user seems stuck, blocked, or frustrated and would benefit from a human follow-up."),
  featureRequest: z.boolean().describe("The user wants something the product does not do."),
  topics: z.array(z.string()).describe("1-3 short topic tags, e.g. 'concurrency', 'failed deploys'."),
  signals: z
    .array(
      z.object({
        type: z.enum(SIGNAL_TYPES),
        severity: z.enum(["low", "med", "high"]),
        detail: z.string(),
        evidence: z.string().optional().describe("A short quote from the user or answer."),
        suggestedAction: z.string().optional(),
      })
    )
    .describe("Typed, actionable signals. Empty when the turn was clean."),
  summary: z.string().describe("One line: what the user asked and how it went."),
});

const JUDGE_SYSTEM = [
  "You evaluate one turn of the Trigger.dev dashboard assistant, a read-only agent that answers questions about a user's runs, tasks, errors, deployments, and environments by calling read tools.",
  "You are given the user's question, the data the agent retrieved through its tools (treat this as the only ground truth), and the agent's answer.",
  "Reason briefly first, then fill in the scores and classification.",
  "Score quality only on factual grounding and whether the question was answered; do not reward verbosity or confidence. Penalize any run id, error name, count, status, version, or metric not present in the tool data.",
  "Then classify the turn for product insight. Flag capabilityGap when the agent could not fully help because it lacked a tool, data, or permission (it is read-only, so any request to change something is a capability gap). Flag docsGap for how-to questions a doc would answer better. Flag supportOpportunity when the user seems stuck or frustrated. Flag featureRequest when they want something the product does not do. Capture concrete, actionable signals.",
].join(" ");

export const evalTurn = task({
  id: "dashboard-agent-eval-turn",
  run: async (payload: EvalTurnPayload, { ctx }) => {
    const { object } = await generateObject({
      model: anthropic(JUDGE_MODEL),
      schema: TurnEval,
      system: JUDGE_SYSTEM,
      prompt: [
        `User question:\n${payload.userText || "(none)"}`,
        `Tools the agent called (ground truth):\n${JSON.stringify(payload.toolActivity, null, 2)}`,
        `Agent answer:\n${payload.assistantText || "(empty)"}`,
        "Evaluate this turn.",
      ].join("\n\n"),
    });

    const toolError = payload.toolActivity.some(
      (t) => t.output != null && typeof t.output === "object" && "error" in (t.output as object)
    );

    await insertTurnEval(getEvalDb().db, {
      chatId: payload.chatId,
      turn: payload.turn,
      organizationId: payload.organizationId,
      userId: payload.userId,
      agentRunId: payload.agentRunId,
      evalRunId: ctx.run.id,
      projectRef: payload.projectRef,
      environment: payload.environment,
      currentPage: payload.currentPage,
      model: payload.model,
      promptSlug: payload.promptSlug,
      promptVersion: payload.promptVersion,
      toolsUsed: payload.toolActivity.map((t) => t.toolName),
      toolError,
      judgeModel: JUDGE_MODEL,
      scoreGrounded: object.grounded,
      scoreAnswered: object.answered,
      scoreConcise: object.concise,
      passed: object.grounded >= 4 && object.answered >= 4,
      intentCategory: object.intentCategory,
      outcome: object.outcome,
      sentiment: object.sentiment,
      capabilityGap: object.capabilityGap,
      docsGap: object.docsGap,
      supportOpportunity: object.supportOpportunity,
      featureRequest: object.featureRequest,
      topics: object.topics,
      signals: object.signals,
      summary: object.summary,
      userText: payload.userText,
      judge: object,
    });

    logger.info("dashboard-agent turn evaluated", {
      chatId: payload.chatId,
      turn: payload.turn,
      outcome: object.outcome,
      passed: object.grounded >= 4 && object.answered >= 4,
    });

    return { summary: object.summary, outcome: object.outcome };
  },
});
