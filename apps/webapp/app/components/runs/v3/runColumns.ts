import type { Prisma } from "@trigger.dev/database";

/**
 * Isomorphic column catalog for the runs list. Shared by the client table
 * renderer, the display-options popover, the URL codec, and the server-side
 * Postgres select derivation, so none of it may import React or server code.
 *
 * The order of `RUN_COLUMN_IDS`/`STANDARD_COLUMNS` is the default column order.
 */
const RUN_COLUMN_IDS = [
  "id",
  "task",
  "status",
  "ver",
  "started",
  "dur",
  "compute",
  "machine",
  "queue",
  "region",
  "test",
  "created",
  "delayed",
  "ttl",
  "tags",
] as const;

export type RunColumnId = (typeof RUN_COLUMN_IDS)[number];

type RunColumnGate = "managedCloud" | "nonDev";

type RunSelectField = keyof Prisma.TaskRunSelect;

export type StandardColumnDef = {
  id: RunColumnId;
  label: string;
  /**
   * When set, the column only exists in this runtime; otherwise it is absent
   * from the table AND the popover (not merely hidden).
   */
  gate?: RunColumnGate;
  /** Locked columns can be reordered but never hidden (their toggle is disabled). */
  locked?: boolean;
  /** Raw ListedRun/TaskRun fields the column needs hydrated from Postgres. */
  fields: readonly RunSelectField[];
};

/**
 * The scalar fields the shared presenter always maps into its stable output,
 * regardless of which columns show. These are all small single-row columns with
 * no DB win from narrowing, so the select keeps them for a stable contract and
 * gates only the large blobs: payload, output, and metadata are added solely
 * when a smart column references them (metadata is display-only on the list, so
 * there is no reason to hydrate it for every row otherwise).
 */
const ALWAYS_SELECTED_FIELDS = [
  "id",
  "friendlyId",
  "taskIdentifier",
  "taskVersion",
  "runtimeEnvironmentId",
  "status",
  "createdAt",
  "queueTimestamp",
  "queuedAt",
  "scheduleId",
  "startedAt",
  "lockedAt",
  "delayUntil",
  "updatedAt",
  "completedAt",
  "isTest",
  "spanId",
  "idempotencyKey",
  "ttl",
  "expiredAt",
  "costInCents",
  "baseCostInCents",
  "usageDurationMs",
  "runTags",
  "depth",
  "rootTaskRunId",
  "batchId",
  "machinePreset",
  "queue",
  "workerQueue",
  "region",
  "annotations",
] as const satisfies readonly RunSelectField[];

const STANDARD_COLUMNS: readonly StandardColumnDef[] = [
  { id: "id", label: "ID", locked: true, fields: ["friendlyId", "spanId"] },
  {
    id: "task",
    label: "Task",
    locked: true,
    fields: ["taskIdentifier", "annotations", "rootTaskRunId"],
  },
  { id: "status", label: "Status", locked: true, fields: ["status"] },
  { id: "ver", label: "Version", fields: ["taskVersion"] },
  { id: "started", label: "Started", fields: ["startedAt", "lockedAt"] },
  {
    id: "dur",
    label: "Duration",
    fields: [
      "startedAt",
      "lockedAt",
      "completedAt",
      "updatedAt",
      "createdAt",
      "queueTimestamp",
      "delayUntil",
      "scheduleId",
      "usageDurationMs",
      "status",
    ],
  },
  {
    id: "compute",
    label: "Compute",
    gate: "managedCloud",
    fields: ["costInCents", "baseCostInCents"],
  },
  { id: "machine", label: "Machine", fields: ["machinePreset"] },
  { id: "queue", label: "Queue", fields: ["queue"] },
  { id: "region", label: "Region", gate: "nonDev", fields: ["region", "workerQueue"] },
  { id: "test", label: "Test", fields: ["isTest"] },
  { id: "created", label: "Created at", fields: ["createdAt"] },
  { id: "delayed", label: "Delayed until", fields: ["delayUntil"] },
  { id: "ttl", label: "TTL", fields: ["ttl", "expiredAt"] },
  { id: "tags", label: "Tags", fields: ["runTags"] },
];

const STANDARD_COLUMNS_BY_ID = new Map(STANDARD_COLUMNS.map((c) => [c.id, c] as const));

const SMART_COLUMN_SOURCES = ["payload", "metadata", "output"] as const;
export type SmartColumnSource = (typeof SMART_COLUMN_SOURCES)[number];

export const SMART_COLUMN_DISPLAYS = ["text", "number", "duration", "badge"] as const;
export type SmartColumnDisplay = (typeof SMART_COLUMN_DISPLAYS)[number];

export type SmartColumnDef = {
  source: SmartColumnSource;
  path: string;
  label: string;
  displayAs: SmartColumnDisplay;
};

const SMART_SOURCE_FIELDS: Record<SmartColumnSource, readonly RunSelectField[]> = {
  payload: ["payload", "payloadType"],
  metadata: ["metadata", "metadataType"],
  output: ["output", "outputType"],
};

/**
 * The search params the column layout lives in. Exported so callers that reason about the
 * runs URL as a whole (e.g. summarising a favorite's filters) can tell layout from filters.
 */
export const RUN_COLUMN_SEARCH_PARAMS = ["cols", "sc", "hide"] as const;

const SMART_REF_PREFIX = "sc";

function smartColumnRef(index: number): string {
  return `${SMART_REF_PREFIX}${index + 1}`;
}

function parseSmartColumnRef(ref: string): number | undefined {
  if (!ref.startsWith(SMART_REF_PREFIX)) return undefined;
  const n = Number(ref.slice(SMART_REF_PREFIX.length));
  return Number.isInteger(n) && n >= 1 ? n - 1 : undefined;
}

/**
 * Build the Postgres `select` for a page from the visible columns. Fields for
 * shown standard columns are added on top of the always-selected set (a no-op
 * while that set is the full scalar contract); payload/output are hydrated
 * solely when a smart column references them.
 */
export function deriveRunSelect(
  visibleStandardIds: readonly RunColumnId[],
  smartSources: readonly SmartColumnSource[]
): Prisma.TaskRunSelect {
  const select: Prisma.TaskRunSelect = {};

  const add = (field: RunSelectField) => {
    (select as Record<string, boolean>)[field] = true;
  };

  for (const field of ALWAYS_SELECTED_FIELDS) add(field);

  for (const id of visibleStandardIds) {
    const def = STANDARD_COLUMNS_BY_ID.get(id);
    if (!def) continue;
    for (const field of def.fields) add(field);
  }

  for (const source of smartSources) {
    for (const field of SMART_SOURCE_FIELDS[source]) add(field);
  }

  return select;
}

export type RunColumnRuntime = {
  isManagedCloud: boolean;
  isDevelopment: boolean;
};

function isColumnAvailable(def: StandardColumnDef, runtime: RunColumnRuntime): boolean {
  switch (def.gate) {
    case "managedCloud":
      return runtime.isManagedCloud;
    case "nonDev":
      return !runtime.isDevelopment;
    default:
      return true;
  }
}

export function availableStandardColumns(runtime: RunColumnRuntime): StandardColumnDef[] {
  return STANDARD_COLUMNS.filter((def) => isColumnAvailable(def, runtime));
}

function escapeSmartPart(value: string): string {
  return value.replace(/%/g, "%25").replace(/:/g, "%3A");
}

function unescapeSmartPart(value: string): string {
  return value.replace(/%3A/g, ":").replace(/%25/g, "%");
}

export function encodeSmartColumn(def: SmartColumnDef): string {
  return [def.source, escapeSmartPart(def.path), escapeSmartPart(def.label), def.displayAs].join(
    ":"
  );
}

export function decodeSmartColumn(raw: string): SmartColumnDef | undefined {
  const parts = raw.split(":");
  if (parts.length < 4) return undefined;

  const [source, path, label, displayAs] = parts;
  if (!SMART_COLUMN_SOURCES.includes(source as SmartColumnSource)) return undefined;
  if (!SMART_COLUMN_DISPLAYS.includes(displayAs as SmartColumnDisplay)) return undefined;

  const decodedPath = unescapeSmartPart(path);
  if (decodedPath.length === 0) return undefined;

  return {
    source: source as SmartColumnSource,
    path: decodedPath,
    label: unescapeSmartPart(label),
    displayAs: displayAs as SmartColumnDisplay,
  };
}

export type ResolvedColumn =
  | { kind: "standard"; def: StandardColumnDef }
  | { kind: "smart"; index: number; def: SmartColumnDef };

/** A column in the popover's full display order, with its current visibility. */
export type LayoutColumn = { col: ResolvedColumn; hidden: boolean };

export type ColumnLayout = {
  /** Every column in display order, hidden ones included (drives the popover). */
  ordered: LayoutColumn[];
  /** Shown columns in display order (drives the table). */
  visible: ResolvedColumn[];
  /** All decoded smart columns (visible or not), indexed by position. */
  smartColumns: SmartColumnDef[];
  /** Whether the layout differs from the default (drives "Reset to default"). */
  isCustomized: boolean;
};

export type ColumnLayoutParams = { cols: string[]; sc: string[]; hide: string[] };
export type EncodedColumnLayout = { cols: string[]; sc: string[]; hide: string[] };

/**
 * The order columns take when `cols` is absent: standard columns in default
 * order, then smart columns in their `sc` definition order.
 */
function canonicalOrder(available: StandardColumnDef[], smartCount: number): string[] {
  return [
    ...available.map((def) => def.id as string),
    ...Array.from({ length: smartCount }, (_, i) => smartColumnRef(i)),
  ];
}

/**
 * Resolve the on-screen layout from the URL params and the runtime gates.
 * `cols` is present only when the order differs from the default; otherwise the
 * default order is used. `hide` lists the columns that are hidden but still
 * occupy their slot, so hiding a column does not rewrite the whole order.
 */
export function resolveColumnLayout(
  params: ColumnLayoutParams,
  runtime: RunColumnRuntime
): ColumnLayout {
  const available = availableStandardColumns(runtime);
  const availableById = new Map(available.map((c) => [c.id, c] as const));
  const smartColumns = params.sc
    .map(decodeSmartColumn)
    .filter((c): c is SmartColumnDef => c !== undefined);
  const hideSet = new Set(params.hide);

  const baseTokens =
    params.cols.length > 0 ? params.cols : canonicalOrder(available, smartColumns.length);

  const ordered: LayoutColumn[] = [];
  const seenStandard = new Set<RunColumnId>();
  const seenSmart = new Set<number>();

  for (const token of baseTokens) {
    const smartIndex = parseSmartColumnRef(token);
    if (smartIndex !== undefined) {
      const def = smartColumns[smartIndex];
      if (!def || seenSmart.has(smartIndex)) continue;
      ordered.push({ col: { kind: "smart", index: smartIndex, def }, hidden: hideSet.has(token) });
      seenSmart.add(smartIndex);
      continue;
    }

    if (seenStandard.has(token as RunColumnId)) continue;
    const def = availableById.get(token as RunColumnId);
    if (!def) continue;
    ordered.push({
      col: { kind: "standard", def },
      hidden: hideSet.has(token) && !def.locked,
    });
    seenStandard.add(def.id);
  }

  ensureAllStandardColumnsPresent(ordered, seenStandard, available);

  for (let i = 0; i < smartColumns.length; i++) {
    if (seenSmart.has(i)) continue;
    ordered.push({
      col: { kind: "smart", index: i, def: smartColumns[i] },
      hidden: hideSet.has(smartColumnRef(i)),
    });
  }

  const visible = ordered.filter((o) => !o.hidden).map((o) => o.col);
  const isCustomized = params.cols.length > 0 || params.hide.length > 0 || smartColumns.length > 0;
  return { ordered, visible, smartColumns, isCustomized };
}

/**
 * Any available standard column missing from `cols` (a locked column, or one
 * added after a URL was saved) is inserted, shown, at its default position.
 */
function ensureAllStandardColumnsPresent(
  ordered: LayoutColumn[],
  seenStandard: Set<RunColumnId>,
  available: StandardColumnDef[]
): void {
  const defaultIndex = new Map(available.map((def, index) => [def.id, index] as const));
  for (const def of available) {
    if (seenStandard.has(def.id)) continue;
    const target = defaultIndex.get(def.id) ?? 0;
    let insertAt = ordered.length;
    for (let i = 0; i < ordered.length; i++) {
      const { col } = ordered[i];
      if (col.kind === "standard" && (defaultIndex.get(col.def.id) ?? 0) > target) {
        insertAt = i;
        break;
      }
    }
    ordered.splice(insertAt, 0, { col: { kind: "standard", def }, hidden: false });
    seenStandard.add(def.id);
  }
}

/**
 * Serialize a layout to compact `cols`/`sc`/`hide` params. `cols` is omitted
 * whenever the order still matches the default, so hiding a column produces just
 * a `hide` entry rather than the entire ordered list. All arrays empty means the
 * default layout, and the caller deletes the keys.
 */
export function encodeColumnLayout(
  ordered: LayoutColumn[],
  runtime: RunColumnRuntime
): EncodedColumnLayout {
  const available = availableStandardColumns(runtime);

  const sc: string[] = [];
  const smartRefByIndex = new Map<number, string>();
  for (const { col } of ordered) {
    if (col.kind === "smart") {
      const ref = smartColumnRef(sc.length);
      smartRefByIndex.set(col.index, ref);
      sc.push(encodeSmartColumn(col.def));
    }
  }

  const tokenFor = (col: ResolvedColumn) =>
    col.kind === "standard" ? (col.def.id as string) : (smartRefByIndex.get(col.index) as string);

  const baseTokens = ordered.map(({ col }) => tokenFor(col));
  const hide = ordered.filter((o) => o.hidden).map(({ col }) => tokenFor(col));

  const canonical = canonicalOrder(available, sc.length);
  const orderIsDefault =
    baseTokens.length === canonical.length && baseTokens.every((t, i) => t === canonical[i]);

  return { cols: orderIsDefault ? [] : baseTokens, sc, hide };
}

/**
 * Parse the raw URL values into layout params. `cols` and `hide` are single
 * comma-joined params; `sc` is repeated.
 */
export function parseColumnParams(
  cols: string | null | undefined,
  sc: string[],
  hide: string | null | undefined
): ColumnLayoutParams {
  const split = (value: string | null | undefined) =>
    value ? value.split(",").filter(Boolean) : [];
  return { cols: split(cols), sc, hide: split(hide) };
}

/** The set of smart-column sources referenced by the visible layout. */
export function visibleSmartSources(visible: ResolvedColumn[]): SmartColumnSource[] {
  const sources = new Set<SmartColumnSource>();
  for (const col of visible) {
    if (col.kind === "smart") sources.add(col.def.source);
  }
  return Array.from(sources);
}

/** Visible standard column ids, for select derivation. */
export function visibleStandardIds(visible: ResolvedColumn[]): RunColumnId[] {
  return visible.filter((c) => c.kind === "standard").map((c) => c.def.id);
}
