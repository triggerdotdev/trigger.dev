import type { CheckpointType } from "./runEngine.js";

export type CheckpointLocationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Where a COMPUTE checkpoint lives: the node holding the snapshot, and the snapshot on it. */
export type ComputeCheckpointLocation = { node: string; snapshotID: string };

/** A Kubernetes node name: a DNS-1123 subdomain, up to 253 chars of dot-separated labels. */
const NODE_LABEL = "[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?";
const NODE_PATTERN = new RegExp(`^(?=.{1,253}$)${NODE_LABEL}(\\.${NODE_LABEL})*$`);
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPAQUE_LOCATION_PATTERN = /^[\x21-\x7e]{1,1024}$/;

export function formatComputeCheckpointLocation(location: ComputeCheckpointLocation): string {
  return `${location.node}/${location.snapshotID}`;
}

/** A node name can't contain a slash and neither can a snapshot id, so the split is exact. */
export function parseComputeCheckpointLocation(
  location: string
): CheckpointLocationResult<ComputeCheckpointLocation> {
  const [node, snapshotID, ...rest] = location.split("/");

  if (rest.length > 0 || node === undefined || snapshotID === undefined) {
    return { ok: false, error: "checkpoint location is not <node>/<snapshot>" };
  }

  if (!NODE_PATTERN.test(node)) {
    return { ok: false, error: "checkpoint location has an invalid node" };
  }

  if (!SNAPSHOT_ID_PATTERN.test(snapshotID)) {
    return { ok: false, error: "checkpoint location has an invalid snapshot id" };
  }

  return { ok: true, value: { node, snapshotID } };
}

/**
 * Rejects a location its restore side could never have produced. COMPUTE locations are parsed
 * exactly; the other types are opaque here and only bounded.
 */
export function validateCheckpointLocation(checkpoint: {
  type: CheckpointType;
  location: string;
}): CheckpointLocationResult<string> {
  if (checkpoint.type === "COMPUTE") {
    const parsed = parseComputeCheckpointLocation(checkpoint.location);
    return parsed.ok ? { ok: true, value: checkpoint.location } : parsed;
  }

  if (!OPAQUE_LOCATION_PATTERN.test(checkpoint.location)) {
    return {
      ok: false,
      error: "checkpoint location must be 1-1024 printable ASCII characters without spaces",
    };
  }

  return { ok: true, value: checkpoint.location };
}
