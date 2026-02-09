
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { updateTriggerPackages } from "./update.js";
import * as nypm from "nypm";
import * as pkgTypes from "pkg-types";
import * as fs from "node:fs/promises";
import * as clack from "@clack/prompts";
import path from "node:path";

// Mock dependencies
vi.mock("nypm");
vi.mock("pkg-types");
vi.mock("node:fs/promises");
vi.mock("@clack/prompts");
vi.mock("std-env", () => ({
    hasTTY: true,
    isCI: false,
}));
vi.mock("../utilities/initialBanner.js", () => ({
    updateCheck: vi.fn().mockResolvedValue(undefined),
    printStandloneInitialBanner: vi.fn(),
}));
vi.mock("../version.js", () => ({
    VERSION: "3.0.0",
}));
vi.mock("../cli/common.js", () => ({
    CommonCommandOptions: { pick: () => ({}) },
}));
vi.mock("../utilities/cliOutput.js", () => ({
    chalkError: vi.fn(),
    prettyError: vi.fn(),
    prettyWarning: vi.fn(),
}));
vi.mock("../utilities/fileSystem.js", () => ({
    removeFile: vi.fn(),
    writeJSONFilePreserveOrder: vi.fn(),
}));
vi.mock("../utilities/logger.js", () => ({
    logger: {
        debug: vi.fn(),
        log: vi.fn(),
        table: vi.fn(),
    },
}));
vi.mock("../utilities/windows.js", () => ({
    spinner: () => ({
        start: vi.fn(),
        message: vi.fn(),
        stop: vi.fn(),
    }),
}));

describe("updateTriggerPackages", () => {
    beforeEach(() => {
        vi.resetAllMocks();

        // Default mocks
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(fs.rm).mockResolvedValue(undefined);
        vi.mocked(pkgTypes.readPackageJSON).mockResolvedValue({
            dependencies: {
                "@trigger.dev/sdk": "2.0.0", // Mismatch
            },
        });
        vi.mocked(pkgTypes.resolvePackageJSON).mockResolvedValue("/path/to/package.json");
        vi.mocked(clack.confirm).mockResolvedValue(true); // User confirms update
        vi.mocked(nypm.installDependencies).mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("should pass --no-engine-strict for npm when ignoreEngines is true", async () => {
        vi.mocked(nypm.detectPackageManager).mockResolvedValue({ name: "npm", command: "npm", version: "1.0.0" } as any);

        await updateTriggerPackages(".", { ignoreEngines: true } as any, true, true);

        expect(nypm.installDependencies).toHaveBeenCalledWith(expect.objectContaining({
            args: ["--no-engine-strict"],
        }));
    });

    it("should pass --config.engine-strict=false for pnpm when ignoreEngines is true", async () => {
        vi.mocked(nypm.detectPackageManager).mockResolvedValue({ name: "pnpm", command: "pnpm", version: "1.0.0" } as any);

        await updateTriggerPackages(".", { ignoreEngines: true } as any, true, true);

        expect(nypm.installDependencies).toHaveBeenCalledWith(expect.objectContaining({
            args: ["--config.engine-strict=false"],
        }));
    });

    it("should pass --ignore-engines for yarn when ignoreEngines is true", async () => {
        vi.mocked(nypm.detectPackageManager).mockResolvedValue({ name: "yarn", command: "yarn", version: "1.0.0" } as any);

        await updateTriggerPackages(".", { ignoreEngines: true } as any, true, true);

        expect(nypm.installDependencies).toHaveBeenCalledWith(expect.objectContaining({
            args: ["--ignore-engines"],
        }));
    });

    it("should NOT pass engine flags if ignoreEngines is false (default)", async () => {
        vi.mocked(nypm.detectPackageManager).mockResolvedValue({ name: "npm", command: "npm", version: "1.0.0" } as any);

        await updateTriggerPackages(".", { ignoreEngines: false } as any, true, true);

        expect(nypm.installDependencies).toHaveBeenCalledWith(expect.objectContaining({
            args: [],
        }));
    });
});
