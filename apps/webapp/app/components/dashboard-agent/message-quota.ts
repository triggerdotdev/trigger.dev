/**
 * The Free plan's cap on messages to the agent. Counted per user across their
 * chats in the org, not per chat, which "New chat" would reset.
 */
export const FREE_PLAN_MESSAGE_LIMIT = 20;

export type MessageQuota =
  /** No cap applies — a paid plan, an unknown plan, or no count in hand. */
  | { kind: "unlimited" }
  /** Under the cap: the composer works, with the remaining count under it. */
  | { kind: "within"; used: number; limit: number; remaining: number }
  /** At the cap: the composer is replaced by the upgrade block. */
  | { kind: "reached"; used: number; limit: number };

/**
 * Whether the cap applies, and what's left of it.
 *
 * Fails open deliberately: an unknown plan or an unknown count means no cap. The
 * cap is a nudge, not a security boundary, so a billing hiccup must never block
 * someone from using the product.
 */
export function resolveMessageQuota({
  isFreePlan,
  used,
  limit = FREE_PLAN_MESSAGE_LIMIT,
}: {
  isFreePlan: boolean | undefined;
  used: number | undefined;
  limit?: number;
}): MessageQuota {
  if (isFreePlan !== true || used === undefined) return { kind: "unlimited" };
  const remaining = Math.max(0, limit - used);
  return remaining === 0
    ? { kind: "reached", used, limit }
    : { kind: "within", used, limit, remaining };
}

export function countUserMessages(messages: { role: string }[]): number {
  return messages.reduce((total, message) => (message.role === "user" ? total + 1 : total), 0);
}
