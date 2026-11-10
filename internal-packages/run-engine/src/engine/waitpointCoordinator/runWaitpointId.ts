import { createHash } from "node:crypto";
import { base32hexEncode, deriveWaitpointIdFromAnchor } from "@trigger.dev/core/v3/isomorphic";

/** Derive the existing native RUN format without changing the child's TaskRun identity or store. */
export function deriveRunWaitpointId(anchorRunId: string): string | undefined {
  const body = anchorRunId.startsWith("run_") ? anchorRunId.slice(4) : anchorRunId;
  const existing = body.length === 26 ? deriveWaitpointIdFromAnchor(body, "RUN") : undefined;
  if (existing) return existing;
  // CUID v1 embeds its millisecond timestamp in the eight base36 characters after `c`.
  // Other historical/malformed identities remain on their existing legacy path.
  if (!/^c[a-z0-9]{24}$/.test(body)) return undefined;
  let timestamp = Number.parseInt(body.slice(1, 9), 36);
  const core = new Uint8Array(15);
  for (let index = 5; index >= 0; index--) {
    core[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  // The existing native layout has nine entropy bytes. Domain separation identifies this derivation
  // independently of other hashes; preserving the timestamp keeps native parser semantics.
  core.set(createHash("sha256").update(`waitpoint:RUN:cuid:${body}`).digest().subarray(0, 9), 6);
  return `${base32hexEncode(core)}rw`;
}
