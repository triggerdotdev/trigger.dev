import { getInternalTestProjects } from "./internal-test-projects.mjs";
import { defineConfig } from "vitest/config";
import { DurationShardingSequencer } from "./internal-packages/testcontainers/src/sequencer.cjs";

// Match the packages selected by `turbo run test --filter "@internal/*"`.
// Load each package's own config so its include/exclude patterns, setup files,
// retries and timeouts still apply. A single discovery pass lets the sequencer
// balance files across packages instead of giving every shard a slice of each.
const projects = getInternalTestProjects(__dirname).map((project) => project.root);

export default defineConfig({
  test: {
    projects,
    sequence: { sequencer: DurationShardingSequencer, concurrent: false },
    fileParallelism: false,
    maxWorkers: 1,
  },
});
