// Ordering is keyed by message id, so a turn the stream replays lands back in its
// own slot rather than after a message sent locally since.

export type TranscriptOrder = {
  base: Map<string, number>;
  live: Map<string, number>;
};

export function createTranscriptOrder(base: ReadonlyArray<{ id: string }>): TranscriptOrder {
  return {
    base: new Map(base.map((message, index) => [message.id, index])),
    live: new Map(),
  };
}

type Orderable = { id: string; parts?: ReadonlyArray<unknown> };

// Mutates `order.live`, so the order object must be long-lived (a ref).
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
