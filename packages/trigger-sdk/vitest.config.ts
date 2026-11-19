import { configDefaults, defineConfig } from "vitest/config";
import aiSdkMajors from "./test/ai-sdk-majors.json" with { type: "json" };

/** Tests that load every AI SDK major themselves, so they run once. */
const acrossMajors = ["test/ai-sdk-step-messages.test.ts", "test/ai-sdk-majors.test.ts"];

/**
 * One project per AI SDK major in `test/ai-sdk-majors.json`. The default major
 * is the installed `ai`; every other one runs the whole suite with `ai` (and
 * its subpaths) resolved to that major's aliased devDependency, SDK source
 * included, so the SDK runs on each major the way a customer's install does.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/v3/**/*.test.ts"],
    globals: true,
    projects: aiSdkMajors.tested.map(({ major, package: pkg }) =>
      major === aiSdkMajors.default
        ? { extends: true, test: { name: `ai-${major}` } }
        : {
            extends: true,
            resolve: { alias: [{ find: /^ai(\/.*)?$/, replacement: `${pkg}$1` }] },
            test: {
              name: `ai-${major}`,
              exclude: [...configDefaults.exclude, ...acrossMajors],
              // Runs the tests listed under `knownFailures` for this major as
              // expected failures.
              setupFiles: ["test/knownFailures.setup.ts"],
              env: { AI_SDK_MAJOR: String(major) },
            },
          }
    ),
  },
});
