import { createHash } from "node:crypto";

// Deterministic, order-independent token over a batch of entry ids. A redelivered
// batch yields the same token, so ClickHouse's raw-table dedup window drops the replay.
// `scope` (the stream key) disambiguates id sets that could collide across streams.
export function dedupTokenFromEntryIds(ids: string[], scope = ""): string {
  const sorted = [...ids].sort();
  return createHash("sha1")
    .update(`${scope}|${sorted.join(",")}`)
    .digest("hex");
}
