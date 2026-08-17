import type { Prisma } from "@trigger.dev/database";

/**
 * Isomorphic column catalog for the runs list. Shared by the client table
 * renderer, the display-options popover, the URL codec, and the server-side
 * Postgres select derivation, so none of it may import React or server code.
 *
 * The order of `RUN_COLUMN_IDS`/`STANDARD_COLUMNS` is the default column order.
 */
export const RUN_COLUMN_IDS = [
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

export type RunColumnGate = "managedCloud" | "nonDev";

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
 * regardless of which columns show. Because the presenter contract is fixed and
 * these are all small single-row columns (no DB win from narrowing them), the
 * select currently gates only the large blobs: payload/output are added solely
 * when a smart column references them. Shrinking this set to a behaviour-only
 * floor later is a change here plus defensive presenter mapping, not an API
 * change to `deriveRunSelect`.
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
  "metadata",
  "metadataType",
  "machinePreset",
  "queue",
  "workerQueue",
  "region",
  "annotations",
] as const satisfies readonly RunSelectField[];

export const STANDARD_COLUMNS: readonly StandardColumnDef[] = [
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

export const SMART_COLUMN_SOURCES = ["payload", "metadata", "output"] as const;
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

const SMART_REF_PREFIX = "sc";

export function smartColumnRef(index: number): string {
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

export type ColumnLayout = {
  /** Visible columns in display order. */
  visible: ResolvedColumn[];
  /** Available standard columns that are currently hidden, in default order. */
  hiddenStandard: StandardColumnDef[];
  /** All decoded smart columns (visible or not), indexed by position. */
  smartColumns: SmartColumnDef[];
  /** Whether the layout differs from the default (drives "Reset to default"). */
  isCustomized: boolean;
};

/**
 * Resolve the on-screen layout from the URL params and the runtime gates. When
 * `cols` is absent the default layout (all available standard columns in
 * default order, no smart columns) is returned and `sc` is ignored.
 */
export function resolveColumnLayout(
  params: { cols: string[]; sc: string[] },
  runtime: RunColumnRuntime
): ColumnLayout {
  const available = availableStandardColumns(runtime);
  const availableById = new Map(available.map((c) => [c.id, c] as const));
  const smartColumns = params.sc
    .map(decodeSmartColumn)
    .filter((c): c is SmartColumnDef => c !== undefined);

  if (params.cols.length === 0) {
    return {
      visible: available.map((def) => ({ kind: "standard", def })),
      hiddenStandard: [],
      smartColumns,
      isCustomized: false,
    };
  }

  const visible: ResolvedColumn[] = [];
  const seenStandard = new Set<RunColumnId>();

  for (const token of params.cols) {
    const smartIndex = parseSmartColumnRef(token);
    if (smartIndex !== undefined) {
      const def = smartColumns[smartIndex];
      if (def) visible.push({ kind: "smart", index: smartIndex, def });
      continue;
    }

    if (seenStandard.has(token as RunColumnId)) continue;
    const def = availableById.get(token as RunColumnId);
    if (!def) continue;
    visible.push({ kind: "standard", def });
    seenStandard.add(def.id);
  }

  ensureLockedColumnsPresent(visible, seenStandard, available);

  const hiddenStandard = available.filter((def) => !def.locked && !seenStandard.has(def.id));

  return { visible, hiddenStandard, smartColumns, isCustomized: true };
}

/**
 * Locked columns can never be hidden, so a `cols` param that omits one (a
 * hand-edited or stale URL) gets it reinserted at its default-order position.
 */
function ensureLockedColumnsPresent(
  visible: ResolvedColumn[],
  seenStandard: Set<RunColumnId>,
  available: StandardColumnDef[]
): void {
  const defaultIndex = new Map(available.map((def, index) => [def.id, index] as const));
  for (const def of available) {
    if (!def.locked || seenStandard.has(def.id)) continue;
    const target = defaultIndex.get(def.id) ?? 0;
    let insertAt = visible.length;
    for (let i = 0; i < visible.length; i++) {
      const col = visible[i];
      if (col.kind === "standard" && (defaultIndex.get(col.def.id) ?? 0) > target) {
        insertAt = i;
        break;
      }
    }
    visible.splice(insertAt, 0, { kind: "standard", def });
    seenStandard.add(def.id);
  }
}

/**
 * Serialize a layout back to `cols`/`sc` params. Returns empty arrays for the
 * default layout so the URL stays clean (the caller deletes both keys).
 */
export function encodeColumnLayout(
  visible: ResolvedColumn[],
  runtime: RunColumnRuntime
): { cols: string[]; sc: string[] } {
  const available = availableStandardColumns(runtime);
  const hasSmart = visible.some((c) => c.kind === "smart");
  const isDefault =
    !hasSmart &&
    visible.length === available.length &&
    visible.every((c, i) => c.kind === "standard" && c.def.id === available[i]?.id);

  if (isDefault) {
    return { cols: [], sc: [] };
  }

  const sc: string[] = [];
  const smartRefByIndex = new Map<number, string>();
  for (const col of visible) {
    if (col.kind === "smart") {
      const ref = smartColumnRef(sc.length);
      smartRefByIndex.set(col.index, ref);
      sc.push(encodeSmartColumn(col.def));
    }
  }

  const cols = visible.map((col) =>
    col.kind === "standard" ? col.def.id : (smartRefByIndex.get(col.index) as string)
  );

  return { cols, sc };
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
