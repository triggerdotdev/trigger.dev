/**
 * The Free plan's cap on messages to the agent.
 *
 * Counted per USER across their chats in the org, not per chat: a per-chat cap
 * would be lifted by clicking "New chat", which isn't a cap at all.
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
 * **Fails open, deliberately.** `isFreePlan` is undefined when the plan isn't
 * known (self-hosted with no billing service, the billing call failed, the org
 * route data hasn't loaded), and `used` is undefined until the count arrives. In
 * both cases the answer is "no cap": a billing hiccup must never be what stops
 * someone using the product, and the cap is a nudge, not a security boundary.
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

/** How many of these messages the user sent. */
export function countUserMessages(messages: { role: string }[]): number {
  return messages.reduce((total, message) => (message.role === "user" ? total + 1 : total), 0);
}
