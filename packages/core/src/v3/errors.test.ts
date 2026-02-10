import { describe, it, expect } from "vitest";
import { prepareDeploymentError } from "./errors.js";

describe("prepareDeploymentError", () => {
    it("should handle [resource_exhausted] error with a friendly message", () => {
        const errorData = {
            name: "Error",
            message: "Build failed: [resource_exhausted] Process exited with code 1",
            stderr: "Some stderr output",
        };

        const result = prepareDeploymentError(errorData);

        // Initial expectation: it passes through (before fix)
        // After fix: it should have a specific message about build resources.
        // For now, let's just assert it returns SOMETHING.
        expect(result).toBeDefined();
        expect(result!.name).toBe("BuildError");
        expect(result!.message).toContain("The build failed because it ran out of resources");
        expect(result!.message).toContain("Try reducing the size of your build context");
    });
});
