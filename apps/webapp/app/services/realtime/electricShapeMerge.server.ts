/**
 * Pure helpers for merging TWO upstream Electric shapes (one per physical run
 * table — `TaskRun` and `task_run_v2`) into a single shape the realtime client
 * consumes. A tag-list or batch feed matches runs in both tables during/after a
 * `runTableV2` cutover, but an Electric shape is bound to one table, so the
 * proxy fans out to two shapes and presents one composite continuation
 * (`handle` / `offset` / `cursor`) that the client round-trips opaquely.
 *
 * Kept dependency-free (no DB/Redis/fetch) so the merge logic is unit-testable.
 */

// Separator packing the two per-table continuation values into one opaque
// token. Electric's handle/offset/cursor values are alphanumeric plus `_`/`-`
// (UUID-ish handles, `<lsn>_<n>` offsets, numeric cursors) and never contain
// `~`, so it is collision-free for this charset.
export const COMPOSITE_SEP = "~";

export const UP_TO_DATE_MESSAGE = { headers: { control: "up-to-date" } } as const;
export const MUST_REFETCH_MESSAGE = { headers: { control: "must-refetch" } } as const;

/** A parsed per-table shape response: continuation headers + the change rows. */
export type ParsedShape = {
  status: number;
  handle?: string;
  offset?: string;
  cursor?: string;
  schema?: string;
  /** Change messages only (control messages stripped). */
  changes: unknown[];
  upToDate: boolean;
  mustRefetch: boolean;
};

/** The prior per-table continuation the client sent (used when a shape is left
 * un-polled because the other returned first). */
export type PriorContinuation = {
  handleA?: string;
  offsetA: string;
  cursorA?: string;
  handleB?: string;
  offsetB: string;
  cursorB?: string;
};

export type MergedShape =
  | { mustRefetch: true }
  | {
      mustRefetch: false;
      changes: unknown[];
      handle: string;
      offset: string;
      cursor?: string;
      schema?: string;
      /**
       * The composite is up-to-date only when BOTH shapes are. An Electric
       * snapshot can span multiple chunks: every chunk but the last omits the
       * `up-to-date` control message. If one table's snapshot is still mid-fetch
       * (chunk 1 of N) while the other has completed, the merged response must
       * NOT terminate with `up-to-date` — otherwise the client believes the
       * whole snapshot is done, flips to live, and never fetches the remaining
       * chunks (silently dropping that table's overflow rows).
       */
      upToDate: boolean;
    };

/**
 * Split a composite "<a>~<b>" value back into its per-table parts. A value with
 * no separator (or null/empty) means the client hasn't been handed a composite
 * yet (the initial request before any shape exists) -> both undefined.
 */
export function decodeCompositePart(value: string | null | undefined): {
  a: string | undefined;
  b: string | undefined;
} {
  if (!value) return { a: undefined, b: undefined };
  const idx = value.indexOf(COMPOSITE_SEP);
  if (idx === -1) return { a: undefined, b: undefined };
  return {
    a: value.slice(0, idx) || undefined,
    b: value.slice(idx + COMPOSITE_SEP.length) || undefined,
  };
}

/**
 * The offset is never absent — Electric uses "-1" for the initial request — so
 * a bare value applies to BOTH shapes (initial), and a composite splits.
 */
export function decodeCompositeOffset(offset: string): { a: string; b: string } {
  const idx = offset.indexOf(COMPOSITE_SEP);
  if (idx === -1) return { a: offset, b: offset };
  return { a: offset.slice(0, idx), b: offset.slice(idx + COMPOSITE_SEP.length) };
}

export function encodeComposite(a: string, b: string): string {
  return `${a}${COMPOSITE_SEP}${b}`;
}

/** Parse the raw body + headers of one upstream shape response. */
export function parseShapeMessages(
  status: number,
  headers: {
    handle?: string;
    offset?: string;
    cursor?: string;
    schema?: string;
  },
  bodyText: string
): ParsedShape {
  const base = { status, ...headers };
  if (status >= 400) {
    return { ...base, changes: [], upToDate: false, mustRefetch: status === 409 };
  }
  let parsed: unknown;
  try {
    parsed = bodyText.trim() ? JSON.parse(bodyText) : [];
  } catch {
    // Unparseable body — safest is to make the client refetch the shape.
    return { ...base, changes: [], upToDate: false, mustRefetch: true };
  }
  if (!Array.isArray(parsed)) {
    return { ...base, changes: [], upToDate: false, mustRefetch: true };
  }
  const messages = parsed as Array<{ headers?: { control?: string } }>;
  const changes = messages.filter((m) => !m?.headers?.control);
  const mustRefetch = messages.some((m) => m?.headers?.control === "must-refetch");
  const upToDate = messages.some((m) => m?.headers?.control === "up-to-date");
  return { ...base, changes, upToDate, mustRefetch };
}

/**
 * Merge two parsed per-table shapes into one composite payload. If either shape
 * needs a refetch (409 / must-refetch / unparseable), the whole composite is
 * reset. Otherwise the change rows are concatenated (the client merges by key,
 * so order across tables doesn't matter) and the continuation values are packed
 * per table, falling back to the client's prior value for a shape that wasn't
 * re-polled this round.
 */
export function mergeParsedShapes(
  a: ParsedShape,
  b: ParsedShape,
  prior: PriorContinuation
): MergedShape {
  if (a.mustRefetch || b.mustRefetch || a.status >= 400 || b.status >= 400) {
    return { mustRefetch: true };
  }
  const cursorA = a.cursor ?? prior.cursorA;
  const cursorB = b.cursor ?? prior.cursorB;
  const cursor =
    cursorA !== undefined || cursorB !== undefined
      ? encodeComposite(cursorA ?? "", cursorB ?? "")
      : undefined;
  return {
    mustRefetch: false,
    changes: [...a.changes, ...b.changes],
    handle: encodeComposite(a.handle ?? prior.handleA ?? "", b.handle ?? prior.handleB ?? ""),
    offset: encodeComposite(a.offset ?? prior.offsetA, b.offset ?? prior.offsetB),
    cursor,
    schema: a.schema ?? b.schema,
    // Only terminate the composite when BOTH shapes have caught up; an
    // un-up-to-date shape (a snapshot chunk that isn't the last) keeps the
    // client requesting the remainder. unpolledShape() reports upToDate:true,
    // so a live round that returns changes from one shape and carries the
    // other forward still terminates iff the polled shape is itself up-to-date.
    upToDate: a.upToDate && b.upToDate,
  };
}

/** A synthetic "no change this round" result for a shape left un-polled because
 * the other returned changes first; carries its prior continuation forward. */
export function unpolledShape(
  which: "a" | "b",
  prior: PriorContinuation
): ParsedShape {
  return {
    status: 200,
    handle: which === "a" ? prior.handleA : prior.handleB,
    offset: which === "a" ? prior.offsetA : prior.offsetB,
    cursor: which === "a" ? prior.cursorA : prior.cursorB,
    changes: [],
    upToDate: true,
    mustRefetch: false,
  };
}
