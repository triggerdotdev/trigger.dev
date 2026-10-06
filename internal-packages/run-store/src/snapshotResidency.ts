// Per-run snapshot storage residency and the versioned queue route that carries it.
//
// Residency is decided once at a run's BIRTH and is immutable for its life. It is NEVER re-derived from
// the live per-org dial. `SnapshotRoute` is the in-memory shape threaded through execution; the wire form
// carries only the version, residency, and organizationId (the run id is always available on the message
// itself, so it is never duplicated on the wire).

/** A run's fixed storage residency. */
export type SnapshotResidency = "postgres" | "mirrored" | "redis-primary";

/** Server-owned context only. Identity alone does not prove a run's storage residency. */
export type SnapshotReadContext = string | SnapshotRouteWire;

/** Durable evidence on an existing snapshot, never the organization's current dial. */
export function snapshotResidencyFromMetadata(metadata: unknown): SnapshotResidency {
  if (typeof metadata !== "object" || metadata === null || !("snapshotStore" in metadata)) {
    return "postgres";
  }
  const marker = metadata.snapshotStore;
  if (
    typeof marker !== "object" ||
    marker === null ||
    !("version" in marker) ||
    marker.version !== 1 ||
    !("residency" in marker) ||
    (marker.residency !== "mirrored" && marker.residency !== "redis-primary")
  ) {
    throw new Error("Unsupported snapshot storage metadata");
  }
  return marker.residency;
}

/** Preserve unrelated snapshot metadata; Postgres-only writes remain byte-identical. */
export function metadataWithSnapshotResidency(
  metadata: unknown,
  residency: Exclude<SnapshotResidency, "postgres">
): { [key: string]: unknown } {
  if (
    metadata !== undefined &&
    metadata !== null &&
    (typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new Error("Snapshot storage metadata requires an object");
  }
  return { ...metadata, snapshotStore: { version: 1, residency } };
}

/** Operation-local server context derived from a stored snapshot. Never sent to a runner. */
export function snapshotRouteFromSnapshot(snapshot: {
  organizationId: string;
  metadata?: unknown;
}): SnapshotRouteWire {
  return {
    version: 1,
    organizationId: snapshot.organizationId,
    residency: snapshotResidencyFromMetadata(snapshot.metadata),
  };
}

export const SNAPSHOT_RESIDENCIES = ["postgres", "mirrored", "redis-primary"] as const;

function isSnapshotResidency(value: unknown): value is SnapshotResidency {
  return value === "postgres" || value === "mirrored" || value === "redis-primary";
}

export type SnapshotRoute = {
  runId: string;
  organizationId: string;
  residency: SnapshotResidency;
};

/**
 * The ONE canonical v1 wire schema, attached to a queue message for an enrolled run. It carries no
 * `runId`: every message already carries a trusted run id, from which the in-memory route is rebuilt.
 */
export type SnapshotRouteWire = {
  version: 1;
  residency: SnapshotResidency;
  organizationId: string;
};

/**
 * Validate an untrusted wire value on deserialize. Returns the normalized route, or `undefined` when the
 * value is absent, a version this build does not understand, or otherwise malformed. NEVER throws: an
 * unusable route must not destroy otherwise-recoverable queued work — the caller falls back to the durable
 * on-demand resolver (and may emit a bounded metric). Extra keys are dropped.
 */
export function parseSnapshotRoute(input: unknown): SnapshotRouteWire | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.version !== 1) {
    return undefined;
  }
  if (!isSnapshotResidency(candidate.residency)) {
    return undefined;
  }
  if (typeof candidate.organizationId !== "string" || candidate.organizationId.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    residency: candidate.residency,
    organizationId: candidate.organizationId,
  };
}

/** The wire form of an in-memory route: version-stamped, run id dropped. */
export function toWireRoute(route: SnapshotRoute): SnapshotRouteWire {
  return {
    version: 1,
    residency: route.residency,
    organizationId: route.organizationId,
  };
}

/** Rebuild the in-memory route from a validated wire route and the message's own trusted run id. */
export function snapshotRouteFromWire(wire: SnapshotRouteWire, runId: string): SnapshotRoute {
  return {
    runId,
    organizationId: wire.organizationId,
    residency: wire.residency,
  };
}
