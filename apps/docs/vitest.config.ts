import { defineConfig } from "vitest/config";

// The app's `@/` import alias (tsconfig paths), for tests that import components.
export default defineConfig({ resolve: { alias: { "@/": `${import.meta.dirname}/` } } });
