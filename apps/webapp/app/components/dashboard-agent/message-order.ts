/**
 * Stable transcript order. The stored copy of a chat is the base order; anything
 * that arrives live goes strictly after it, in the order it first appeared.
 *
 * Ordering is keyed by message id because the stored copy can lag the turn that
 * just finished, so the stream may replay a turn the base already has. Keying by
 * id puts a replayed turn back in its own slot instead of after a message the
 * user sent locally in the meantime.
 */

export type TranscriptOrder = {
  /** Message id -> its index in the stored transcript. */
  base: Map<string, number>;
  /** Message id -> the order it first arrived live. */
  live: Map<string, number>;
};

/** The order to rank against: the stored transcript as loaded. */
export function createTranscriptOrder(base: ReadonlyArray<{ id: string }>): TranscriptOrder {
  return {
    base: new Map(base.map((message, index) => [message.id, index])),
    live: new Map(),
  };
}

type Orderable = { id: string; parts?: ReadonlyArray<unknown> };

/**
 * The messages in stable order, one copy per id.
 *
 * Registers ids it hasn't seen before in `order.live`, so the order object must
 * be long-lived (a ref) — it is the memory of what arrived when.
 */
export function orderTranscript<T extends Orderable>(
  messages: ReadonlyArray<T>,
  order: TranscriptOrder
): T[] {
  const chosen = new Map<string, T>();

  for (const message of messages) {
    if (!order.base.has(message.id) && !order.live.has(message.id)) {
      order.live.set(message.id, order.live.size);
    }
    const existing = chosen.get(message.id);
    // The later (streamed) copy wins, unless it has no parts yet.
    if (existing && partCount(message) === 0 && partCount(existing) > 0) continue;
    chosen.set(message.id, message);
  }

  return [...chosen.values()]
    .map((message, arrival) => ({ message, arrival, rank: rankOf(message.id, order) }))
    .sort((a, b) => a.rank - b.rank || a.arrival - b.arrival)
    .map((entry) => entry.message);
}

function partCount(message: Orderable): number {
  return message.parts?.length ?? 0;
}

function rankOf(id: string, order: TranscriptOrder): number {
  const base = order.base.get(id);
  if (base !== undefined) return base;
  return order.base.size + (order.live.get(id) ?? 0);
}
