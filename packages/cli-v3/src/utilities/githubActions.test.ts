import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setGithubActionsOutputAndEnvVars } from "./githubActions.js";

describe("setGithubActionsOutputAndEnvVars", () => {
  const originalGithubEnv = process.env.GITHUB_ENV;
  const originalGithubOutput = process.env.GITHUB_OUTPUT;
  let tmpDir: string | undefined;

  afterEach(() => {
    if (originalGithubEnv === undefined) {
      delete process.env.GITHUB_ENV;
    } else {
      process.env.GITHUB_ENV = originalGithubEnv;
    }

    if (originalGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalGithubOutput;
    }

    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("terminates GitHub Actions env and output entries with newlines", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "trigger-github-actions-"));
    const envFile = join(tmpDir, "env");
    const outputFile = join(tmpDir, "output");
    process.env.GITHUB_ENV = envFile;
    process.env.GITHUB_OUTPUT = outputFile;

    setGithubActionsOutputAndEnvVars({
      envVars: {
        deploymentId: "dep_123",
        imageTag: "v1",
      },
      outputs: {
        deploymentId: "dep_123",
        needsPromotion: "true",
      },
    });

    expect(readFileSync(envFile, "utf8")).toMatch(/^deploymentId=dep_123\r?\nimageTag=v1\r?\n$/);
    expect(readFileSync(outputFile, "utf8")).toMatch(
      /^deploymentId=dep_123\r?\nneedsPromotion=true\r?\n$/
    );
  });

  it("does not append content when there are no env vars or outputs", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "trigger-github-actions-"));
    const envFile = join(tmpDir, "env");
    const outputFile = join(tmpDir, "output");
    writeFileSync(envFile, "");
    writeFileSync(outputFile, "");
    process.env.GITHUB_ENV = envFile;
    process.env.GITHUB_OUTPUT = outputFile;

    setGithubActionsOutputAndEnvVars({
      envVars: {},
      outputs: {},
    });

    expect(readFileSync(envFile, "utf8")).toBe("");
    expect(readFileSync(outputFile, "utf8")).toBe("");
  });
});
