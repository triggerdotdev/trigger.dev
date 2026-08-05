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

// Latest-wins within one array only: highest `revision` at the winner's position,
// ties to the last. Blocks without an envelope are all kept, in order.
export function latestRevisionBlocks<T>(blocks: readonly T[]): T[] {
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

  if (winnerIndexByIdentity.size === 0) return [...blocks];

  return blocks.filter((block, index) => {
    const identity = blockIdentity(block);
    return identity === undefined || winnerIndexByIdentity.get(identity) === index;
  });
}
