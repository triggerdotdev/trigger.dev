import type { Limits } from "@trigger.dev/platform";
import {
  getAgentMessageUsage,
  incrementAgentMessageUsage,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import { getCachedLimit } from "./platform.v3.server";
import { logger } from "./logger.server";

// The repo's unlimited sentinel. Never Infinity: it serializes to null in the limit cache.
export const UNLIMITED_AGENT_MESSAGES = 100_000_000;

// Filled by cloud billing (TRI-12863 P0). Absent until then, and always on self-hosted,
// so the fallback applies and the cap is effectively off.
const AGENT_MESSAGE_LIMIT_KEY = "agentMessages" as keyof Limits;

/** The billing period the counter is scoped to: a UTC calendar month, "YYYY-MM". */
export function currentAgentMessagePeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Pure so the send routes and, later, the MCP path share one rule. */
export function checkAgentMessageQuota({ used, limit }: { used: number; limit: number }): {
  reached: boolean;
} {
  return { reached: used >= limit };
}

export type AgentMessageQuota = { reached: boolean; used: number; limit: number };

/**
 * The period counter and the cached plan limit for one org. Fails open: an absent limit
 * (self-hosted, or before the cloud side ships) resolves to the unlimited sentinel, and a
 * counter read that throws returns `undefined` — either way there is no cap.
 */
export async function resolveAgentMessageQuota(
  db: DashboardAgentDb,
  params: {
    organizationId: string;
    now?: Date;
    readLimit?: (organizationId: string) => Promise<number>;
  }
): Promise<AgentMessageQuota | undefined> {
  const readLimit =
    params.readLimit ??
    (async (organizationId: string) => {
      const cached = await getCachedLimit(
        organizationId,
        AGENT_MESSAGE_LIMIT_KEY,
        UNLIMITED_AGENT_MESSAGES
      );
      // A cache error leaves `val` empty; fall open to unlimited.
      return cached.val ?? UNLIMITED_AGENT_MESSAGES;
    });
  try {
    const [limit, used] = await Promise.all([
      readLimit(params.organizationId),
      getAgentMessageUsage(db, {
        organizationId: params.organizationId,
        period: currentAgentMessagePeriod(params.now),
      }),
    ]);
    return { ...checkAgentMessageQuota({ used, limit }), used, limit };
  } catch (error) {
    logger.error("Failed to resolve dashboard agent message quota", {
      organizationId: params.organizationId,
      error,
    });
    return undefined;
  }
}

/** Record one sent user message. Swallows errors: the cap is a nudge, never a send blocker. */
export async function recordAgentMessageSent(
  db: DashboardAgentDb,
  params: { organizationId: string; now?: Date }
): Promise<void> {
  try {
    await incrementAgentMessageUsage(db, {
      organizationId: params.organizationId,
      period: currentAgentMessagePeriod(params.now),
    });
  } catch (error) {
    logger.error("Failed to record a dashboard agent message against the quota", {
      organizationId: params.organizationId,
      error,
    });
  }
}

/**
 * Whether an agent turn consumes quota. A wake/action turn is server-placed — the user never
 * spent it — so only a `message` turn that is not an action counts. The `.in` proxy already
 * refuses action turns; this keeps the rule explicit and testable.
 */
export function agentTurnCountsAgainstQuota(
  turn: { kind?: string; payload?: { trigger?: string } } | undefined
): boolean {
  return turn?.kind === "message" && turn.payload?.trigger !== "action";
}
