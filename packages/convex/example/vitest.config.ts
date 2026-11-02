import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{src,convex,trigger,shared}/**/*.test.{ts,tsx}"],
  },
});
