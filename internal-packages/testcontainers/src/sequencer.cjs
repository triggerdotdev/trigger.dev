// Authored as plain CommonJS (NOT .ts) on purpose. vitest loads each package's vitest.config.ts by
// bundling it, and it EXTERNALIZES this workspace subpath - node then loads this file verbatim. A .ts
// here reaches node as raw TypeScript and crashes config loading on CI's pinned node 20 (no type
// stripping: `SyntaxError`). Keeping it dependency-free JS - and importing nothing from the ESM-only
// `vitest/node` - makes it loadable on every node. Types for consumers live in sequencer.d.cts.

const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

// Walk up from the package dir (cwd at config-load time) to the monorepo root (pnpm-workspace.yaml).
function findRepoRoot(start) {
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

let cachedTimings;

function loadTimings() {
  if (!cachedTimings) {
    cachedTimings = existsSync(TIMINGS_PATH) ? JSON.parse(readFileSync(TIMINGS_PATH, "utf-8")) : {};
  }
  return cachedTimings;
}

function median(nums) {
  if (nums.length === 0) return 1;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Duration-weighted interpretation of `--shard=i/N`. Instead of vitest's default file-count split,
 * this greedily bin-packs test files by recorded duration (test-timings.json at the repo root;
 * unknown/new files get the median) so each shard does roughly equal work.
 *
 * The packing is fully deterministic (sort by duration desc, then moduleId) so every shard computes
 * the identical bins and just takes its own - no file runs twice or gets dropped. Falls back to the
 * full set when no shard is configured, and to ~count-based when no timings exist.
 *
 * Implemented as a standalone TestSequencer (not extending BaseSequencer) so this file never imports
 * `vitest/node` - see the header note.
 */
class DurationShardingSequencer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // Deterministic order (heaviest first, then moduleId) - stable across shards and a sensible
  // in-shard run order, replacing BaseSequencer's default sort we no longer inherit.
  async sort(files) {
    const timings = loadTimings();
    const fallback = median(Object.values(timings));
    return [...files].sort((a, b) => {
      const am = timings[path.relative(REPO_ROOT, a.moduleId)] ?? fallback;
      const bm = timings[path.relative(REPO_ROOT, b.moduleId)] ?? fallback;
      return bm - am || a.moduleId.localeCompare(b.moduleId);
    });
  }

  async shard(specs) {
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

    const bins = Array.from({ length: shard.count }, () => ({ total: 0, specs: [] }));

    for (const { spec, ms } of weighted) {
      const lightest = bins.reduce((min, bin) => (bin.total < min.total ? bin : min));
      lightest.total += ms;
      lightest.specs.push(spec);
    }

    return bins[shard.index - 1].specs;
  }
}

module.exports = { DurationShardingSequencer };
