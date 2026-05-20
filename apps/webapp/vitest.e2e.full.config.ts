import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Comprehensive auth e2e suite — see TRI-8731. Boots a single
// webapp + Postgres + Redis container in globalSetup and rapid-fires
// tests against it across multiple test files. Distinct from the smoke
// suite (vitest.e2e.config.ts) which uses per-file beforeAll setup and
// runs in default CI on every PR.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.full.test.ts"],
    globalSetup: ["./test/setup/global-e2e-full-setup.ts"],
    globals: true,
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
