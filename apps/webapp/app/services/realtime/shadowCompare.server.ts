import {
  type ElectricColumnType,
  RUN_ELECTRIC_COLUMNS,
  serializeRunRow,
} from "./electricStreamProtocol.server";
import { type RunHydrator, type RunListFilter, type RunListResolver } from "./runReader.server";

/**
 * Dual-run shadow-compare.
 *
 * The client is always served the Electric response; in the background this
 * re-derives what the notifier path WOULD emit and diffs the two, so we can prove
 * parity on real production traffic before any cutover.
 *
 * Two kinds of divergence are checked:
 *  - serialization: for each run Electric emitted, re-hydrate it and serialize via
 *    the notifier serializer, then compare SEMANTICALLY (decode both sides per
 *    column type) so equivalent-but-differently-encoded wire values (timestamp
 *    format, bool t/true, number formatting) are not false positives. The compare
 *    is gated on same-version (matching updatedAt) so a row that changed between
 *    Electric's emit and our refetch is recorded as "skew", not a divergence.
 *  - membership (tag/batch initial snapshot only): the set of run ids Electric
 *    emitted vs the set the notifier resolver returns. This is where the known
 *    tag OR-vs-AND difference shows up.
 *
 * Pure except for the injected RunHydrator/RunListResolver, so it's unit-testable.
 */

export type ShadowFeed = "run" | "runs" | "batch";

type WireValue = Record<string, string | null>;

type ShapeMessage = {
  key?: string;
  value?: WireValue;
  headers: { operation?: string; control?: string };
};

const COLUMN_BY_NAME = new Map(RUN_ELECTRIC_COLUMNS.map((column) => [column.name, column]));

export type ColumnDiff = {
  runId: string;
  column: string;
  electric: string | null;
  notifier: string | null;
};

export type ShadowCompareOutcome = {
  feed: ShadowFeed;
  /** Runs whose every emitted column matched (same-version). */
  serializationMatched: number;
  /** Runs with at least one semantic column divergence (same-version). */
  serializationDiverged: number;
  /** Runs that changed between Electric's emit and our refetch (not a divergence). */
  serializationSkew: number;
  /** Per-column divergences (capped) for logging. */
  diffs: ColumnDiff[];
  /** Set membership (tag/batch initial snapshot only). undefined when not checked. */
  membershipMatch?: boolean;
  missingInNotifier?: string[];
  extraInNotifier?: string[];
};

export type ShadowCompareInput = {
  feed: ShadowFeed;
  /** The served Electric response body (a JSON array of messages, or "" / "[]"). */
  electricBody: string;
  environment: { id: string };
  skipColumns: string[];
  /** True when this was an initial snapshot request (offset=-1); enables membership compare. */
  isInitialSnapshot: boolean;
  /** When set (tag/batch initial snapshot), compare the resolved id-set. */
  membershipFilter?: RunListFilter;
};

const MAX_DIFFS = 20;

export class RealtimeShadowComparator {
  constructor(
    private readonly options: { runReader: RunHydrator; runListResolver: RunListResolver }
  ) {}

  async compare(input: ShadowCompareInput): Promise<ShadowCompareOutcome> {
    const messages = parseBody(input.electricBody);
    const changes = messages.filter(
      (m): m is ShapeMessage & { value: WireValue } =>
        typeof m.headers?.operation === "string" && !!m.value && m.headers.operation !== "delete"
    );

    const outcome: ShadowCompareOutcome = {
      feed: input.feed,
      serializationMatched: 0,
      serializationDiverged: 0,
      serializationSkew: 0,
      diffs: [],
    };

    for (const message of changes) {
      const runId = message.value.id ?? undefined;
      if (!runId) {
        continue;
      }

      const row = await this.options.runReader.getRunById(input.environment.id, runId);
      if (!row) {
        // Run no longer readable (deleted / replica miss). Not a serialization divergence.
        outcome.serializationSkew++;
        continue;
      }

      const notifierValue = serializeRunRow(row, input.skipColumns);

      // Only compare rows at the same version; otherwise the row advanced between
      // Electric's emit and our refetch (timing skew, not a divergence).
      if (!sameInstant(message.value.updatedAt, notifierValue.updatedAt)) {
        outcome.serializationSkew++;
        continue;
      }

      let rowDiverged = false;
      for (const [column, electricRaw] of Object.entries(message.value)) {
        const meta = COLUMN_BY_NAME.get(column);
        if (!meta) {
          continue;
        }
        const notifierRaw = notifierValue[column] ?? null;
        if (!valuesEqual(electricRaw, notifierRaw, meta.type, meta.dims, column)) {
          rowDiverged = true;
          if (outcome.diffs.length < MAX_DIFFS) {
            outcome.diffs.push({ runId, column, electric: electricRaw, notifier: notifierRaw });
          }
        }
      }

      if (rowDiverged) {
        outcome.serializationDiverged++;
      } else {
        outcome.serializationMatched++;
      }
    }

    if (input.isInitialSnapshot && input.membershipFilter) {
      const electricIds = new Set(
        changes.map((m) => m.value.id).filter((id): id is string => typeof id === "string")
      );
      const notifierIds = new Set(
        await this.options.runListResolver.resolveMatchingRunIds(input.membershipFilter)
      );

      outcome.missingInNotifier = [...electricIds].filter((id) => !notifierIds.has(id));
      outcome.extraInNotifier = [...notifierIds].filter((id) => !electricIds.has(id));
      outcome.membershipMatch =
        outcome.missingInNotifier.length === 0 && outcome.extraInNotifier.length === 0;
    }

    return outcome;
  }
}

function parseBody(body: string): ShapeMessage[] {
  const text = body.trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ShapeMessage[]) : [];
  } catch {
    return [];
  }
}

/** Status carries a known legacy rewrite (DEQUEUED -> EXECUTING) applied equally to
 * both paths for non-current API versions; treat them as equivalent. */
function normalizeStatus(value: string): string {
  return value === "DEQUEUED" ? "EXECUTING" : value;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  // Mirror the SDK's RawShapeDate (`new Date(val + "Z")`).
  return new Date(`${a}Z`).getTime() === new Date(`${b}Z`).getTime();
}

function valuesEqual(
  electricRaw: string | null,
  notifierRaw: string | null,
  type: ElectricColumnType,
  dims: number | undefined,
  column: string
): boolean {
  if (electricRaw == null || notifierRaw == null) {
    return electricRaw == null && notifierRaw == null;
  }

  if (dims && dims > 0) {
    return arraysEqual(parsePgTextArray(electricRaw), parsePgTextArray(notifierRaw));
  }

  switch (type) {
    case "timestamp":
      return new Date(`${electricRaw}Z`).getTime() === new Date(`${notifierRaw}Z`).getTime();
    case "bool":
      return parseBool(electricRaw) === parseBool(notifierRaw);
    case "int4":
    case "int8":
    case "float8":
      return Number(electricRaw) === Number(notifierRaw);
    case "jsonb":
      return jsonEqual(electricRaw, notifierRaw);
    case "text":
    default:
      if (column === "status") {
        return normalizeStatus(electricRaw) === normalizeStatus(notifierRaw);
      }
      return electricRaw === notifierRaw;
  }
}

function parseBool(value: string): boolean {
  return value === "t" || value === "true";
}

function jsonEqual(a: string, b: string): boolean {
  try {
    return deepEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return a === b;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    return (
      ak.length === bk.length &&
      ak.every((k, i) => k === bk[i]) &&
      ak.every((k) => deepEqual((a as any)[k], (b as any)[k]))
    );
  }
  return false;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Parse a Postgres text-array literal (`{"a","b"}` / `{}`). Mirrors the client's pgArrayParser. */
function parsePgTextArray(literal: string): string[] {
  if (literal === "{}" || literal === "") {
    return [];
  }
  const inner = literal.startsWith("{") && literal.endsWith("}") ? literal.slice(1, -1) : literal;
  const result: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      i++;
      let s = "";
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === "\\") {
          i++;
        }
        s += inner[i];
        i++;
      }
      result.push(s);
      i++;
      if (inner[i] === ",") i++;
    } else {
      let s = "";
      while (i < inner.length && inner[i] !== ",") {
        s += inner[i];
        i++;
      }
      result.push(s);
      if (inner[i] === ",") i++;
    }
  }
  return result;
}
