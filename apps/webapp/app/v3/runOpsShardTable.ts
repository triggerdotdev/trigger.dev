// Pure boot-table helpers. Dependency-free (no db.server, no env) so a test of these two string
// functions never constructs a Prisma client. db.server imports them for the boot log.

// A host:port/db address, with NO username and NO query params — never a secret, and deliberately
// NOT an identity claim (two DSNs can share an address yet be different databases; that proof is the
// distinctness sentinel's, not this line's). Same tuple sameDatabaseTarget compares, kept in step.
export function runOpsAddressFingerprint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "unparseable";
  }
}

export type RunOpsShardTableRow = { key: string; fingerprint: string; role: string };

// The resolved shard table for the boot log: one row per descriptor. An alias reports its role and
// carries no address (it shares the new store's pool).
export function buildRunOpsShardTable(
  descriptors: Array<{ key: string; url?: string; aliasOf?: "new" }>
): RunOpsShardTableRow[] {
  return descriptors.map((d) =>
    d.aliasOf
      ? { key: d.key, fingerprint: "alias(new)", role: "alias(new)" }
      : { key: d.key, fingerprint: runOpsAddressFingerprint(d.url ?? ""), role: "shard" }
  );
}
