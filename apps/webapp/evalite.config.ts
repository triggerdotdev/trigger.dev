import { defineConfig } from "evalite/config";
import tsconfigPaths from "vite-tsconfig-paths";

// evalite 1.0 runs its own Vite instance and does not pick up `vitest.config.ts`,
// so the `~/*` -> `./app/*` path alias must be wired in explicitly here (mirrors
// the plugin setup in vitest.config.ts).
export default defineConfig({
  viteConfig: {
    // @ts-ignore - vite-tsconfig-paths plugin type vs evalite's bundled vite version
    plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
  },
});
