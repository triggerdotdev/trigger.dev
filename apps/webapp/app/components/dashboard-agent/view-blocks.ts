// Envelope is `blockEnvelopeSchema` in `@internal/dashboard-agent-contracts`. Blocks
// arrive as tool output, so every read here is defensive rather than typed.

type MaybeEnveloped = {
  type?: unknown;
  id?: unknown;
  revision?: unknown;
};

// Undefined when the block has no envelope; such blocks are never grouped.
export function blockIdentity(block: unknown): string | undefined {
  const { type, id } = (block ?? {}) as MaybeEnveloped;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof type !== "string") return undefined;
  return `${type}::${id}`;
}

function blockRevision(block: unknown): number {
  const { revision } = (block ?? {}) as MaybeEnveloped;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

// Falls back to the array index: pre-envelope blocks have nothing stable to key on.
export function blockKey(block: unknown, index: number): string {
  return blockIdentity(block) ?? `index:${index}`;
}

/**
 * Latest-wins within one array only: highest `revision` at the winner's position, ties to the
 * last. Blocks without an envelope are all kept, in order. Each survivor keeps the index it had
 * in `blocks`, which is what an envelope-less block is keyed on — a search for it afterwards
 * would answer with the first equal block, not this one.
 */
export function latestRevisionEntries<T>(blocks: readonly T[]): { block: T; index: number }[] {
  if (!Array.isArray(blocks)) return [];

  const winnerIndexByIdentity = new Map<string, number>();
  blocks.forEach((block, index) => {
    const identity = blockIdentity(block);
    if (identity === undefined) return;
    const currentWinner = winnerIndexByIdentity.get(identity);
    if (
      currentWinner === undefined ||
      blockRevision(blocks[currentWinner]) <= blockRevision(block)
    ) {
      winnerIndexByIdentity.set(identity, index);
    }
  });

  const entries: { block: T; index: number }[] = [];
  blocks.forEach((block, index) => {
    const identity = blockIdentity(block);
    if (identity === undefined || winnerIndexByIdentity.get(identity) === index) {
      entries.push({ block, index });
    }
  });
  return entries;
}

/** {@link latestRevisionEntries} without the positions. */
export function latestRevisionBlocks<T>(blocks: readonly T[]): T[] {
  return latestRevisionEntries(blocks).map((entry) => entry.block);
}
