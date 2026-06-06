import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Walk up from the package dir (cwd at config-load time) to the monorepo root, identified by
// pnpm-workspace.yaml. (Can't use __dirname - vitest bundles the config + this import as ESM.)
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// test-timings.json lives at the monorepo root: { "<repo-relative path>": <ms> }
const REPO_ROOT = findRepoRoot(process.cwd());
const TIMINGS_PATH = path.resolve(REPO_ROOT, "test-timings.json");

let cachedTimings: Record<string, number> | undefined;

function loadTimings(): Record<string, number> {
  if (!cachedTimings) {
    cachedTimings = existsSync(TIMINGS_PATH)
      ? (JSON.parse(readFileSync(TIMINGS_PATH, "utf-8")) as Record<string, number>)
      : {};
  }
  return cachedTimings;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 1;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Duration-weighted interpretation of `--shard=i/N`. Instead of vitest's default file-count split,
 * this greedily bin-packs test files by recorded duration (test-timings.json at the repo root;
 * unknown/new files get the median) so each shard does roughly equal work.
 *
 * The packing is fully deterministic (sort by duration desc, then moduleId) so every shard computes
 * the identical bins and just takes its own - no file runs twice or gets dropped. Falls back to the
 * full set when no shard is configured, and to ~count-based when no timings exist.
 */
export class DurationShardingSequencer extends BaseSequencer {
  async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard || specs.length === 0) {
      return specs;
    }

    const timings = loadTimings();
    const fallback = median(Object.values(timings));

    const weighted = specs
      .map((spec) => ({
        spec,
        ms: timings[path.relative(REPO_ROOT, spec.moduleId)] ?? fallback,
      }))
      .sort((a, b) => b.ms - a.ms || a.spec.moduleId.localeCompare(b.spec.moduleId));

    const bins = Array.from({ length: shard.count }, () => ({
      total: 0,
      specs: [] as TestSpecification[],
    }));

    for (const { spec, ms } of weighted) {
      const lightest = bins.reduce((min, bin) => (bin.total < min.total ? bin : min));
      lightest.total += ms;
      lightest.specs.push(spec);
    }

    return bins[shard.index - 1]!.specs;
  }
}
