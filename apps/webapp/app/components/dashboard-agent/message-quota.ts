import { isWatchRequestMessageId } from "@internal/dashboard-agent-contracts";

// Counted per user across their chats in the org, not per chat, which "New chat"
// would reset.
export const FREE_PLAN_MESSAGE_LIMIT = 20;

/**
 * The cap to show: the plan limit the server resolved, when it resolved a finite one. The
 * server sends null while no plan limit exists (self-hosted, or before billing carries one),
 * and then the free-plan nudge is the cap — dropping it would remove the nudge entirely.
 */
export function resolveMessageLimit(serverLimit: number | null | undefined): number {
  return typeof serverLimit === "number" ? serverLimit : FREE_PLAN_MESSAGE_LIMIT;
}

/**
 * What a `?quota=1` body should change: a coherent `{used, limit}` read, `disabled` when the
 * server has turned the quota off (an explicit signal, not the caller's stale cache), or null
 * for a degraded body. `used`/`limit` move together: applying a `{}` on top of a good read
 * field-by-field would keep the count and drop back to the nudge limit, which reads as
 * "reached" against a cap the server never set.
 */
export function quotaResponseUpdate(
  data: { used?: number; limit?: number | null; enabled?: boolean } | null | undefined
): { used: number; limit: number | null } | { disabled: true } | null {
  if (data?.enabled === false) return { disabled: true };
  if (typeof data?.used !== "number") return null;
  return { used: data.used, limit: typeof data.limit === "number" ? data.limit : null };
}

export type MessageQuota =
  | { kind: "unlimited"; reason?: "disabled" }
  | { kind: "within"; used: number; limit: number; remaining: number }
  | { kind: "reached"; used: number; limit: number };

// Fails open: the cap is a nudge, not a security boundary, so an unknown plan or
// count means no cap.
export function resolveMessageQuota({
  isFreePlan,
  used,
  limit = FREE_PLAN_MESSAGE_LIMIT,
  disabled,
}: {
  isFreePlan: boolean | undefined;
  used: number | undefined;
  limit?: number;
  disabled?: boolean;
}): MessageQuota {
  if (disabled) return { kind: "unlimited", reason: "disabled" };
  if (isFreePlan !== true || used === undefined) return { kind: "unlimited" };
  const remaining = Math.max(0, limit - used);
  return remaining === 0
    ? { kind: "reached", used, limit }
    : { kind: "within", used, limit, remaining };
}

/**
 * Whether a refusal-set cap can be released: a read that proves capacity is back, or the
 * server saying the quota is off outright. Absent any server read (degraded body, nothing
 * read yet) the block stays, so the composer never flashes back for someone the server is
 * about to refuse again.
 *
 * `provenCapacity` carries the raw server read past the plan model: the server enforces the
 * same billing limit on every plan, but a paid plan resolves to `unlimited` here (it has no
 * nudge to show), so its `within` read would otherwise never release the block.
 */
export function shouldClearCapReached(quota: MessageQuota & { provenCapacity?: boolean }): boolean {
  if (quota.provenCapacity) return true;
  return quota.kind === "within" || (quota.kind === "unlimited" && quota.reason === "disabled");
}

// The server code both the create and `in` paths refuse with. The client owns the copy,
// so this code must never reach the UI as text.
export const MESSAGE_QUOTA_REACHED_ERROR = "message_quota_reached";

// Maps a 403 refusal body to the cap signal, or null for any other error. Both paths use
// this so a `message_quota_reached` code routes to the upgrade block, never a raw toast.
export function parseQuotaReachedResponse(
  status: number,
  data: { error?: string; limit?: number } | null | undefined
): { limit: number; planResolved: boolean } | null {
  if (status === 403 && data?.error === MESSAGE_QUOTA_REACHED_ERROR) {
    return typeof data.limit === "number"
      ? { limit: data.limit, planResolved: true }
      : { limit: FREE_PLAN_MESSAGE_LIMIT, planResolved: false };
  }
  return null;
}

/**
 * The upgrade block's sentence. Pure so the copy is asserted directly, and so the raw
 * server code can never be what the user reads. Only the client's free-plan nudge may name
 * the Free plan — a server-resolved cap also lands on paying orgs, whose allowance isn't it.
 */
export function messageQuotaReachedCopy(limit: number, planResolved: boolean): string {
  return planResolved
    ? `You've used all ${limit} messages included in your plan this month. Your chats stay here to read.`
    : `You've used all ${limit} messages included on the Free plan. Your chats stay here to read.`;
}

/** Why a suggestion chip is disabled: the upgrade block carries the full sentence. */
export const MESSAGE_QUOTA_REACHED_REASON = "You've used your message allowance";

// A watch's consent record is a user message the person never typed, so it is
// excluded here exactly as the stored count excludes it.
export function countUserMessages(messages: { role: string; id?: string }[]): number {
  return messages.reduce(
    (total, message) =>
      message.role === "user" && !isWatchRequestMessageId(message.id) ? total + 1 : total,
    0
  );
}
