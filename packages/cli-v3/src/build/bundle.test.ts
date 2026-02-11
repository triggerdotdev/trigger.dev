import { expect, test, vi, describe, beforeEach, afterEach } from "vitest";
import { bundleWorker } from "./bundle.js";
import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { shims } from "./packageModules.js";
import { join } from "node:path";

vi.mock("esbuild", () => ({
    build: vi.fn(),
    context: vi.fn(() => ({
        watch: vi.fn(),
        dispose: vi.fn(),
    })),
}));

vi.mock("node:fs/promises", () => ({
    copyFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(() => []),
    readFile: vi.fn(),
}));

vi.mock("../utilities/fileSystem.js", () => ({
    createFile: vi.fn(),
    createFileWithStore: vi.fn(),
}));

vi.mock("./entryPoints.js", () => ({
    createEntryPointManager: vi.fn(() => ({
        entryPoints: ["src/trigger/task.ts"],
        patterns: [],
        stop: vi.fn(),
    })),
}));

vi.mock("./plugins.js", () => ({
    buildPlugins: vi.fn(() => []),
    SdkVersionExtractor: vi.fn(() => ({
        plugin: { name: "sdk-version" },
    })),
}));

vi.mock("./manifests.js", () => ({
    copyManifestToDir: vi.fn(),
}));

vi.mock("../utilities/sourceFiles.js", () => ({
    resolveFileSources: vi.fn(),
}));

vi.mock("../utilities/logger.js", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock("../utilities/cliOutput.js", () => ({
    cliLink: vi.fn(),
    prettyError: vi.fn(),
}));

vi.mock("../cli/common.js", () => ({
    SkipLoggingError: class extends Error { },
}));

describe("bundleWorker with Yarn PnP support", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test("should copy shims to .trigger/shims and use them in inject", async () => {
        const workingDir = "/project";
        const options = {
            target: "deploy" as const,
            destination: "/dist",
            cwd: workingDir,
            resolvedConfig: {
                workingDir,
                dirs: ["src/trigger"],
                build: {
                    jsx: { automatic: true }
                }
            } as any,
        };

        vi.mocked(esbuild.build).mockResolvedValue({
            outputFiles: [],
            metafile: {
                outputs: {
                    "dist/index.mjs": {
                        entryPoint: "src/entryPoints/managed-run-worker.js",
                    },
                    "dist/controller.mjs": {
                        entryPoint: "src/entryPoints/managed-run-controller.js",
                    },
                    "dist/index-worker.mjs": {
                        entryPoint: "src/entryPoints/managed-index-worker.js",
                    },
                    "dist/index-controller.mjs": {
                        entryPoint: "src/entryPoints/managed-index-controller.js",
                    },
                    "dist/config.mjs": {
                        entryPoint: "trigger.config.ts",
                    }
                }
            },
            errors: [],
            warnings: [],
        } as any);

        await bundleWorker(options);

        // Verify mkdir was called for .trigger/shims
        expect(mkdir).toHaveBeenCalledWith(join(workingDir, ".trigger", "shims"), { recursive: true });

        // Verify copyFile was called for each shim
        for (const shim of shims) {
            expect(copyFile).toHaveBeenCalledWith(shim, expect.stringContaining(join(".trigger", "shims")));
        }

        // Verify esbuild.build was called with local shim paths in inject
        expect(esbuild.build).toHaveBeenCalledWith(
            expect.objectContaining({
                inject: expect.arrayContaining([expect.stringContaining(join(".trigger", "shims"))]),
            })
        );
    });
});
