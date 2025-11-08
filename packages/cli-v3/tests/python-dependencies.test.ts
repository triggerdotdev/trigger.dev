import { describe, it, expect } from "vitest";
import {
  parseRequirementsTxt,
  generateRequirementsTxt,
  validateRequirementsTxt,
  type PythonDependency,
} from "../src/build/pythonDependencies.js";

describe("Python Dependencies - Requirements.txt parser", () => {
  describe("parseRequirementsTxt", () => {
    it("parses basic package names", () => {
      const content = `
pydantic
requests
numpy
      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(3);
      expect(deps[0]).toEqual({ name: "pydantic" });
      expect(deps[1]).toEqual({ name: "requests" });
      expect(deps[2]).toEqual({ name: "numpy" });
    });

    it("parses packages with exact versions", () => {
      const content = `
pydantic==2.0.0
requests==2.28.0
numpy==1.24.0
      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(3);
      expect(deps[0]).toEqual({ name: "pydantic", version: "==2.0.0" });
      expect(deps[1]).toEqual({ name: "requests", version: "==2.28.0" });
      expect(deps[2]).toEqual({ name: "numpy", version: "==1.24.0" });
    });

    it("parses packages with version ranges", () => {
      const content = `
requests>=2.28.0
numpy>=1.20.0,<2.0.0
pydantic~=2.0.0
      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(3);
      expect(deps[0]).toEqual({ name: "requests", version: ">=2.28.0" });
      expect(deps[1].name).toBe("numpy");
      expect(deps[1].version).toContain(">=1.20.0");
      expect(deps[1].version).toContain("<2.0.0");
      expect(deps[2]).toEqual({ name: "pydantic", version: "~=2.0.0" });
    });

    it("parses packages with extras", () => {
      const content = `
requests[security,socks]==2.28.0
pydantic[email]>=2.0.0
      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(2);
      expect(deps[0]).toEqual({
        name: "requests",
        extras: ["security", "socks"],
        version: "==2.28.0",
      });
      expect(deps[1]).toEqual({
        name: "pydantic",
        extras: ["email"],
        version: ">=2.0.0",
      });
    });

    it("ignores comments and empty lines", () => {
      const content = `
# This is a comment
pydantic==2.0.0

# Another comment
requests>=2.28.0

      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(2);
      expect(deps[0]).toEqual({ name: "pydantic", version: "==2.0.0" });
      expect(deps[1]).toEqual({ name: "requests", version: ">=2.28.0" });
    });

    it("handles mixed operators and extras", () => {
      const content = `
scipy[extra1,extra2]==1.9.0
matplotlib>=3.0.0,<4.0.0
pandas
      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(3);
      expect(deps[0]).toEqual({
        name: "scipy",
        extras: ["extra1", "extra2"],
        version: "==1.9.0",
      });
      expect(deps[1].name).toBe("matplotlib");
      expect(deps[1].version).toContain(">=3.0.0");
      expect(deps[1].version).toContain("<4.0.0");
      expect(deps[2]).toEqual({ name: "pandas" });
    });

    it("handles packages with hyphens and underscores", () => {
      const content = `
flask-cors==3.0.0
some_package>=1.0.0
      `.trim();

      const deps = parseRequirementsTxt(content);

      expect(deps).toHaveLength(2);
      expect(deps[0]).toEqual({ name: "flask-cors", version: "==3.0.0" });
      expect(deps[1]).toEqual({ name: "some_package", version: ">=1.0.0" });
    });
  });

  describe("generateRequirementsTxt", () => {
    it("generates requirements.txt from dependencies", () => {
      const deps: PythonDependency[] = [
        { name: "pydantic", version: "==2.0.0" },
        { name: "requests", version: ">=2.28.0" },
        { name: "numpy" },
      ];

      const content = generateRequirementsTxt(deps);

      expect(content).toBe("pydantic==2.0.0\nrequests>=2.28.0\nnumpy");
    });

    it("generates requirements.txt with extras", () => {
      const deps: PythonDependency[] = [
        { name: "requests", version: "==2.28.0", extras: ["security", "socks"] },
        { name: "pydantic", extras: ["email", "dotenv"] },
      ];

      const content = generateRequirementsTxt(deps);

      expect(content).toBe("requests[security,socks]==2.28.0\npydantic[email,dotenv]");
    });

    it("round-trips parse and generate", () => {
      const originalContent = `
# Production dependencies
pydantic==2.0.0
requests[security,socks]>=2.28.0
numpy>=1.20.0
      `.trim();

      const deps = parseRequirementsTxt(originalContent);
      const regeneratedContent = generateRequirementsTxt(deps);

      // Parse again to verify round-trip
      const deps2 = parseRequirementsTxt(regeneratedContent);

      expect(deps).toHaveLength(deps2.length);
      expect(deps[0]).toEqual(deps2[0]);
      expect(deps[1]).toEqual(deps2[1]);
      expect(deps[2]).toEqual(deps2[2]);
    });
  });

  describe("validateRequirementsTxt", () => {
    it("validates correct requirements.txt", () => {
      const content = `
pydantic==2.0.0
requests[security]>=2.28.0
numpy>=1.20.0,<2.0.0
      `.trim();

      const result = validateRequirementsTxt(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("reports errors with line numbers", () => {
      const content = `
pydantic==2.0.0
!invalid-package
requests>=2.28.0
      `.trim();

      const result = validateRequirementsTxt(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Line"))).toBe(true);
    });

    it("handles empty content", () => {
      const result = validateRequirementsTxt("");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
