
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sourceMapSupport from "source-map-support";
import { installSourceMapSupport } from "./sourceMaps.js";

vi.mock("source-map-support", () => ({
    default: {
        install: vi.fn(),
    },
}));

describe("installSourceMapSupport", () => {
    const originalEnv = process.env;
    const originalSetSourceMapsEnabled = process.setSourceMapsEnabled;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        // Mock setSourceMapsEnabled if it doesn't exist (Node < 16.6) or restore it
        process.setSourceMapsEnabled = vi.fn();
    });

    afterEach(() => {
        process.env = originalEnv;
        process.setSourceMapsEnabled = originalSetSourceMapsEnabled;
    });

    it("should install source-map-support by default (undefined env var)", () => {
        delete process.env.TRIGGER_SOURCE_MAPS;
        installSourceMapSupport();
        expect(sourceMapSupport.install).toHaveBeenCalledWith({
            handleUncaughtExceptions: false,
            environment: "node",
            hookRequire: false,
        });
    });

    it("should install source-map-support if env var is 'true'", () => {
        process.env.TRIGGER_SOURCE_MAPS = "true";
        installSourceMapSupport();
        expect(sourceMapSupport.install).toHaveBeenCalled();
    });

    it("should NOT install source-map-support if env var is 'false'", () => {
        process.env.TRIGGER_SOURCE_MAPS = "false";
        installSourceMapSupport();
        expect(sourceMapSupport.install).not.toHaveBeenCalled();
    });

    it("should NOT install source-map-support if env var is '0'", () => {
        process.env.TRIGGER_SOURCE_MAPS = "0";
        installSourceMapSupport();
        expect(sourceMapSupport.install).not.toHaveBeenCalled();
    });

    it("should enable native node source maps if env var is 'node'", () => {
        process.env.TRIGGER_SOURCE_MAPS = "node";
        installSourceMapSupport();
        expect(sourceMapSupport.install).not.toHaveBeenCalled();
        expect(process.setSourceMapsEnabled).toHaveBeenCalledWith(true);
    });
});
