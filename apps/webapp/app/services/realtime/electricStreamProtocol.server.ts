/**
 * Electric HTTP shape-stream wire protocol serializer for the single-run feed.
 *
 * This re-emits the exact wire shape that the deployed `@electric-sql/client`
 * (1.0.14 modern + 0.4.0 legacy) and the SDK's `SubscribeRunRawShape` expect,
 * so the notifier-backed realtime feed stays byte-faithful to what those clients
 * already expect.
 *
 * The module is intentionally pure: no DB, Redis, or env access, so the wire
 * contract can be unit-tested by round-tripping through the real client parser
 * + the SDK schema. Header rewrites, tokens, and transport live in the client.
 *
 * Wire facts this encodes (verified against @electric-sql/client@1.0.14):
 *  - Response body is a JSON array of messages; an empty body is treated as `[]`.
 *  - Each column value is wire-encoded as a STRING (or null); the client decodes
 *    it back using the per-column `electric-schema` header. Columns absent from
 *    the schema are passed through unparsed (so text/timestamp stay strings).
 *  - `up-to-date` is the only control message that makes the client emit rows.
 *  - Re-sending the full row each cycle is idempotent: the client merges by `key`.
 */

export type ElectricColumnType =
  | "text"
  | "timestamp"
  | "int4"
  | "int8"
  | "float8"
  | "bool"
  | "jsonb";

type ElectricColumn = {
  name: string;
  type: ElectricColumnType;
  /** Array dimensionality. 1 => `type[]` (Postgres `{a,b}` literal). */
  dims?: number;
  /**
   * Array columns only. True when the Postgres column has NO default, so an
   * empty/absent value is stored as SQL NULL (Electric emits `null`) rather than
   * an empty-array literal `{}`. Prisma erases this distinction — it coerces both
   * NULL and `{}` to `[]` on read — so we re-derive the wire form from the column's
   * known schema. `runTags` has no default; `realtimeStreams` has `@default([])`.
   */
  emptyArrayAsNull?: boolean;
};

/**
 * The columns the realtime run feed exposes, mirroring `DEFAULT_ELECTRIC_COLUMNS`
 * in `realtimeClient.server.ts` and their Postgres types from the `TaskRun`
 * Prisma model. The `type`/`dims` drive both the `electric-schema` header and
 * the value encoding. Keep in sync with `DEFAULT_ELECTRIC_COLUMNS`.
 */
export const RUN_ELECTRIC_COLUMNS: ReadonlyArray<ElectricColumn> = [
  { name: "id", type: "text" },
  { name: "taskIdentifier", type: "text" },
  { name: "createdAt", type: "timestamp" },
  { name: "updatedAt", type: "timestamp" },
  { name: "startedAt", type: "timestamp" },
  { name: "delayUntil", type: "timestamp" },
  { name: "queuedAt", type: "timestamp" },
  { name: "expiredAt", type: "timestamp" },
  { name: "completedAt", type: "timestamp" },
  { name: "friendlyId", type: "text" },
  { name: "number", type: "int4" },
  { name: "isTest", type: "bool" },
  { name: "status", type: "text" },
  { name: "usageDurationMs", type: "int4" },
  { name: "costInCents", type: "float8" },
  { name: "baseCostInCents", type: "float8" },
  { name: "ttl", type: "text" },
  { name: "payload", type: "text" },
  { name: "payloadType", type: "text" },
  { name: "metadata", type: "text" },
  { name: "metadataType", type: "text" },
  { name: "output", type: "text" },
  { name: "outputType", type: "text" },
  { name: "runTags", type: "text", dims: 1, emptyArrayAsNull: true },
  { name: "error", type: "jsonb" },
  { name: "realtimeStreams", type: "text", dims: 1 },
];

/** Columns that can never be skipped via `skipColumns` (mirrors realtimeClient). */
export const RESERVED_COLUMNS = ["id", "taskIdentifier", "friendlyId", "status", "createdAt"];

/**
 * Shape of a single run hydrated for the realtime feed. Structurally compatible
 * with the Prisma `TaskRun` projection produced by `RunHydrator`.
 */
export type RealtimeRunRow = {
  id: string;
  taskIdentifier: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  delayUntil: Date | null;
  queuedAt: Date | null;
  expiredAt: Date | null;
  completedAt: Date | null;
  friendlyId: string;
  number: number;
  isTest: boolean;
  status: string;
  usageDurationMs: number;
  costInCents: number;
  baseCostInCents: number;
  ttl: string | null;
  payload: string;
  payloadType: string;
  metadata: string | null;
  metadataType: string;
  output: string | null;
  outputType: string;
  runTags: string[];
  error: unknown;
  realtimeStreams: string[];
};

type Operation = "insert" | "update" | "delete";

type ChangeMessage = {
  key: string;
  value: Record<string, string | null>;
  headers: { operation: Operation };
};

type ControlMessage = {
  headers: { control: "up-to-date" | "must-refetch" };
};

type ShapeMessage = ChangeMessage | ControlMessage;

const UP_TO_DATE: ControlMessage = { headers: { control: "up-to-date" } };

function effectiveSkipColumns(skipColumns: string[]): Set<string> {
  return new Set(skipColumns.filter((c) => c !== "" && !RESERVED_COLUMNS.includes(c)));
}

function quoteArrayElement(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function pgArrayLiteral(values: unknown[]): string {
  if (values.length === 0) {
    return "{}";
  }
  return `{${values.map((v) => quoteArrayElement(String(v))).join(",")}}`;
}

function serializeValue(value: unknown, column: ElectricColumn): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (column.dims && column.dims > 0) {
    if (!Array.isArray(value)) {
      return null;
    }
    // A no-default array column stores NULL when empty, so Electric emits `null`
    // (not `{}`); match that here since Prisma handed us `[]` for the NULL value.
    if (value.length === 0 && column.emptyArrayAsNull) {
      return null;
    }
    return pgArrayLiteral(value);
  }

  switch (column.type) {
    case "bool":
      // Postgres text representation; the client's parseBool accepts "t"/"f".
      return value ? "t" : "f";
    case "timestamp":
      // The SDK's RawShapeDate appends "Z" before parsing, so we emit the ISO
      // string WITHOUT the trailing "Z".
      return value instanceof Date ? value.toISOString().slice(0, -1) : String(value);
    case "jsonb":
      return JSON.stringify(value);
    case "int4":
    case "int8":
    case "float8":
    case "text":
    default:
      return String(value);
  }
}

/** The merge key the client uses to reassemble a row across insert/update cycles. */
export function runShapeKey(runId: string): string {
  return `"public"."TaskRun"/"${runId}"`;
}

/** Encode a single run row into the wire `value` object (column -> string|null). */
export function serializeRunRow(
  row: RealtimeRunRow,
  skipColumns: string[] = []
): Record<string, string | null> {
  const skip = effectiveSkipColumns(skipColumns);
  const value: Record<string, string | null> = {};

  for (const column of RUN_ELECTRIC_COLUMNS) {
    if (skip.has(column.name)) {
      continue;
    }
    value[column.name] = serializeValue((row as Record<string, unknown>)[column.name], column);
  }

  return value;
}

/** The `electric-schema` response header value for the (optionally trimmed) column set. */
export function buildElectricSchemaHeader(skipColumns: string[] = []): string {
  const skip = effectiveSkipColumns(skipColumns);
  const schema: Record<string, { type: string; dims?: number }> = {};

  for (const column of RUN_ELECTRIC_COLUMNS) {
    if (skip.has(column.name)) {
      continue;
    }
    schema[column.name] = column.dims ? { type: column.type, dims: column.dims } : { type: column.type };
  }

  return JSON.stringify(schema);
}

/**
 * Initial snapshot body: a single `insert` for the row (if it exists) followed by
 * `up-to-date`. An absent row emits a bare `up-to-date` (an empty shape), which is
 * how Electric represents "no rows match".
 */
export function buildSnapshotBody(row: RealtimeRunRow | null, skipColumns: string[] = []): string {
  const messages: ShapeMessage[] = [];
  if (row) {
    messages.push({
      key: runShapeKey(row.id),
      value: serializeRunRow(row, skipColumns),
      headers: { operation: "insert" },
    });
  }
  messages.push(UP_TO_DATE);
  return JSON.stringify(messages);
}

/** Live body when the row advanced: a full-row `update` followed by `up-to-date`. */
export function buildUpdateBody(row: RealtimeRunRow, skipColumns: string[] = []): string {
  const messages: ShapeMessage[] = [
    {
      key: runShapeKey(row.id),
      value: serializeRunRow(row, skipColumns),
      headers: { operation: "update" },
    },
    UP_TO_DATE,
  ];
  return JSON.stringify(messages);
}

/** Live body when nothing advanced: a bare `up-to-date` (no row emission). */
export function buildUpToDateBody(): string {
  return JSON.stringify([UP_TO_DATE]);
}

export type RowChange = { row: RealtimeRunRow; operation: "insert" | "update" };

/**
 * Multi-row body for the tag-list feed: one change message per row (insert for
 * rows new to the shape, update for rows that advanced) followed by `up-to-date`.
 * An empty `changes` array emits a bare `up-to-date`. The client merges every row
 * by key, so re-emitting a full row is idempotent.
 */
export function buildRowsBody(changes: RowChange[], skipColumns: string[] = []): string {
  const messages: ShapeMessage[] = changes.map((change) => ({
    key: runShapeKey(change.row.id),
    value: serializeRunRow(change.row, skipColumns),
    headers: { operation: change.operation },
  }));
  messages.push(UP_TO_DATE);
  return JSON.stringify(messages);
}

export const INITIAL_OFFSET = "-1";

/**
 * Opaque offset token, formatted to satisfy the client's `${number}_${number}`
 * type. The first segment is the row's `updatedAt` epoch-ms (lets a live request
 * detect whether the replica row has advanced past what the client already has);
 * the second is a per-connection sequence counter.
 */
export function encodeOffset(updatedAtMs: number, seq: number): string {
  return `${Math.trunc(updatedAtMs)}_${Math.trunc(seq)}`;
}

/** Extract the `updatedAt` epoch-ms a client last saw from its echoed offset. */
export function parseOffsetUpdatedAtMs(offset: string | null | undefined): number {
  if (!offset) {
    return 0;
  }
  const [first] = offset.split("_");
  const value = Number(first);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Mirror of realtimeClient's DEQUEUED->EXECUTING rewrite for non-current API versions. */
export function rewriteBodyForLegacyApiVersion(body: string): string {
  return body.replace(/"status":"DEQUEUED"/g, '"status":"EXECUTING"');
}
