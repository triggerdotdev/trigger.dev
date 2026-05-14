import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // *.e2e.test.ts: smoke matrix, run via vitest.e2e.config.ts.
    // *.e2e.full.test.ts: full auth suite, runs via vitest.e2e.full.config.ts
    // (needs a globalSetup-spawned webapp + Postgres container).
    exclude: ["test/**/*.e2e.test.ts", "test/**/*.e2e.full.test.ts"],
    globals: true,
    pool: "forks",
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
