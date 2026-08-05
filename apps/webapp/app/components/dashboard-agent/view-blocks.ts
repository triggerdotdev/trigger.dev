// Envelope handling for the agent's view blocks. The envelope is defined by
// `blockEnvelopeSchema` in `@internal/dashboard-agent-contracts`: `id` is stable
// identity within a conversation, `revision` increases when the agent re-emits
// the same block with better information. Blocks replayed from a pre-envelope
// transcript have neither, so everything here degrades to rendering all of them
// in order. Reads defensively rather than trusting the parsed type, since blocks
// arrive as tool output.

type MaybeEnveloped = {
  type?: unknown;
  id?: unknown;
  revision?: unknown;
};

/**
 * The identity two blocks must share to be revisions of each other: type + id.
 * Undefined when the block has no envelope — such blocks are never grouped.
 */
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

/**
 * The React key for a block: its identity when it has an envelope, else the
 * array index (legacy blocks have nothing stable to key on).
 */
export function blockKey(block: unknown, index: number): string {
  return blockIdentity(block) ?? `index:${index}`;
}

/**
 * Latest-wins within one blocks array: when several blocks share (type, id),
 * keep only the highest `revision`, at that winner's position. Ties keep the
 * last one, the newest emission. Blocks without an envelope are all kept, in
 * order. Cross-message grouping is a later milestone.
 */
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
