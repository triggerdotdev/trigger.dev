type FilterKeySource = {
  events: ReadonlyArray<{ id: string; data: { isError: boolean } }>;
  /** Times a span already shown got a new message. */
  messageChanges: number;
};

/**
 * Changes when what errors-only or search reads changes on spans already in the tree. Which
 * spans are errors, not how many: one can stop being an error as another becomes one.
 */
export function traceFilterKey(sources: Iterable<FilterKeySource>): string {
  const parts: string[] = [];
  for (const source of sources) {
    let errors = 0;
    let errorIds = 0;
    for (const event of source.events) {
      if (!event.data.isError) continue;
      errors++;
      errorIds = (errorIds + hashId(event.id)) | 0;
    }
    parts.push(`${errors}.${errorIds}.${source.messageChanges}`);
  }
  return parts.join("|");
}

// FNV-1a; summed, so the order spans arrive in doesn't matter.
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  }
  return hash;
}
