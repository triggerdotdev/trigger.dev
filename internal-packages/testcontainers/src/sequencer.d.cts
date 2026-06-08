import type { TestSequencer, TestSpecification, Vitest } from "vitest/node";

/**
 * Duration-weighted `--shard=i/N`: bin-packs test files by recorded duration (test-timings.json at
 * the repo root) so each shard does roughly equal work. The runtime lives in `sequencer.cjs` (plain
 * JS, so vitest config loading can load it on any node - see that file's header); this declaration
 * supplies the types for configs that wire it via `sequence: { sequencer: DurationShardingSequencer }`.
 */
export declare class DurationShardingSequencer implements TestSequencer {
  constructor(ctx: Vitest);
  sort(files: TestSpecification[]): Promise<TestSpecification[]>;
  shard(files: TestSpecification[]): Promise<TestSpecification[]>;
}
