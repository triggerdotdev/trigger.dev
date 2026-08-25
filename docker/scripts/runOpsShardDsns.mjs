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

  const dsns = [];
  for (const descriptor of parsed) {
    if (descriptor === null || typeof descriptor !== "object") {
      throw new Error("RUN_OPS_SHARDS holds an entry that is not an object");
    }
    // An aliased shard is the same database as its target, which is migrated by its own invocation.
    if (descriptor.aliasOf !== undefined && descriptor.aliasOf !== null) {
      continue;
    }
    const dsn = descriptor.directUrl ?? descriptor.url;
    if (typeof dsn !== "string" || dsn === "") {
      continue;
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
