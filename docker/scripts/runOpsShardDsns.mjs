// Print the migration DSN of every run-ops shard that owns its own database, one per line, so
// entrypoint.sh can loop over them. The runner image has no `jq`, and this script is unit-tested,
// which an inline `node -e` string could not be.
//
// Contract:
//   RUN_OPS_SHARDS unset or blank -> print nothing, exit 0 (single-DB and gen-1-only installs)
//   invalid JSON, or not an array -> message on stderr, exit 1 (the app rejects the same value)
//   a descriptor with `aliasOf`    -> skipped; it shares its target's database
//   the DSN                        -> `directUrl` if set, else `url`; skipped if neither is set
//
// Never print a DSN to stderr or to a log: stdout is consumed by the caller, nothing else.

// Mirrors isValidDatabaseUrl in the webapp: parseable by URL(), and no empty `schema` param.
function assertDatabaseUrl(value, field, key) {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.get("schema") === "") {
      throw new Error("empty schema param");
    }
  } catch {
    throw new Error(`RUN_OPS_SHARDS[${key}]: ${field} is not a valid database URL`);
  }
}

/**
 * Mirrors the boot schema's rules for one descriptor. Kept deliberately narrow: it checks the rules
 * that make the application REJECT the value at boot, so an invalid descriptor stops the entrypoint
 * before any migration runs. It does NOT reject unknown fields, because doing so would fail the
 * entrypoint on a descriptor a newer application accepts, which is drift in the other direction.
 */
function assertDescriptor(d) {
  const key = typeof d.key === "string" ? d.key : "?";
  if (typeof d.key !== "string" || !/^[a-z0-9]$/.test(d.key)) {
    throw new Error(`RUN_OPS_SHARDS[${key}]: key must be a single [a-z0-9] char`);
  }
  if (typeof d.region !== "string" || d.region === "") {
    throw new Error(`RUN_OPS_SHARDS[${key}]: region is required`);
  }

  const hasAlias = d.aliasOf !== undefined && d.aliasOf !== null;
  if (hasAlias && d.aliasOf !== "new") {
    throw new Error(`RUN_OPS_SHARDS[${key}]: aliasOf must be "new", got "${d.aliasOf}"`);
  }

  const hasUrl = d.url !== undefined && d.url !== null;
  if (hasUrl === hasAlias) {
    throw new Error(`RUN_OPS_SHARDS[${key}]: exactly one of url or aliasOf is required`);
  }

  for (const field of ["url", "replicaUrl", "directUrl"]) {
    const value = d[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value === "") {
      throw new Error(`RUN_OPS_SHARDS[${key}]: ${field} is not a valid database URL`);
    }
    assertDatabaseUrl(value, field, key);
  }

  if (hasAlias) return;

  const rep = d.replication;
  if (rep === undefined || rep === null || typeof rep !== "object") {
    throw new Error(`RUN_OPS_SHARDS[${key}]: replication is required unless aliasOf is set`);
  }
  for (const field of ["slotName", "publicationName"]) {
    if (typeof rep[field] !== "string" || rep[field] === "") {
      throw new Error(`RUN_OPS_SHARDS[${key}]: replication.${field} must be a non-empty string`);
    }
  }
  const gen = rep.originGeneration;
  if (!Number.isInteger(gen) || gen < 2 || gen > 255) {
    throw new Error(
      `RUN_OPS_SHARDS[${key}]: replication.originGeneration must be an integer 2..255`
    );
  }
}

export function shardMigrationDsns(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RUN_OPS_SHARDS is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("RUN_OPS_SHARDS is not a JSON array");
  }

  // Validate EVERY descriptor before collecting any DSN, so a valid descriptor ahead of an invalid
  // one never gets its database migrated before the configuration is rejected.
  for (const descriptor of parsed) {
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error("RUN_OPS_SHARDS holds an entry that is not an object");
    }
    assertDescriptor(descriptor);
  }

  const dsns = [];
  for (const descriptor of parsed) {
    // An aliased shard is the same database as its target, which its own invocation migrates.
    if (descriptor.aliasOf !== undefined && descriptor.aliasOf !== null) continue;

    const dsn = descriptor.directUrl ?? descriptor.url;
    // One DSN per line IS the protocol with the caller, so a DSN holding a line break would split
    // into two bogus DSNs. The URL parser strips ASCII line breaks, so nothing else rejects it.
    if (/[\r\n]/.test(dsn)) {
      throw new Error("RUN_OPS_SHARDS holds a DSN containing a line break");
    }
    dsns.push(dsn);
  }
  return dsns;
}

// `import.meta.main` is not available on every supported node, so compare argv instead.
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("runOpsShardDsns.mjs");

if (invokedDirectly) {
  try {
    for (const dsn of shardMigrationDsns(process.env.RUN_OPS_SHARDS)) {
      process.stdout.write(`${dsn}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
