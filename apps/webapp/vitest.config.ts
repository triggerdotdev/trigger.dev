import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "app/**/*.test.ts"],
    globals: true,
    pool: "forks",
  },
  // @ts-ignore
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
});
