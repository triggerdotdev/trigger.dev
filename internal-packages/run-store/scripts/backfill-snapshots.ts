// Break-glass Redis -> Postgres snapshot reconstruction. DRY-RUN by default; pass --apply to write.
//   pnpm exec tsx scripts/backfill-snapshots.ts --run <runId> [--run <runId> ...] [--apply] [--dedicated]
// Connections come from env: REDIS_HOST/REDIS_PORT/REDIS_PASSWORD and DATABASE_URL.
import { PrismaClient } from "@trigger.dev/database";
import { createRedisClient } from "@internal/redis";
import {
  readRunSnapshotsForBackfill,
  snapshotRowsFromRedis,
  applyBackfill,
} from "../src/snapshotBackfill.js";

function parseArgs(argv: string[]) {
  const runIds: string[] = [];
  let apply = false;
  let dedicated = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run") runIds.push(argv[++i]);
    else if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--dedicated") dedicated = true;
  }
  return { runIds, apply, dedicated };
}

async function main() {
  const { runIds, apply, dedicated } = parseArgs(process.argv.slice(2));
  if (runIds.length === 0) {
    console.error("usage: backfill-snapshots.ts --run <runId> [--run ...] [--apply] [--dedicated]");
    process.exit(1);
  }

  const redis = createRedisClient({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
    password: process.env.REDIS_PASSWORD,
  });
  const prisma = new PrismaClient();

  try {
    let totalWritten = 0;
    const allUnreconstructable: unknown[] = [];
    for (const runId of runIds) {
      const data = await readRunSnapshotsForBackfill(redis, runId);
      if (!data) {
        console.log(`[skip] ${runId}: no keyspace in Redis`);
        continue;
      }
      const { rows, report } = snapshotRowsFromRedis(data);
      allUnreconstructable.push(...report.unreconstructable);
      const result = await applyBackfill(prisma, rows, {
        dryRun: !apply,
        schemaVariant: dedicated ? "dedicated" : "legacy",
      });
      totalWritten += rows.length;
      console.log(
        `[${apply ? "apply" : "dry-run"}] ${runId}: ${rows.length} rows, ` +
          `${result.written} written, ${result.linked} links`
      );
    }
    if (allUnreconstructable.length > 0) {
      console.warn(`UNRECONSTRUCTABLE (${allUnreconstructable.length}):`);
      for (const u of allUnreconstructable) console.warn("  " + JSON.stringify(u));
    }
    if (!apply) {
      console.log(`\nDRY RUN — nothing written. Re-run with --apply. (${totalWritten} rows would write)`);
    }
  } finally {
    await redis.quit();
    await prisma.$disconnect();
  }
}

void main();
