import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setGithubActionsOutputAndEnvVars } from "./githubActions.js";

describe("setGithubActionsOutputAndEnvVars", () => {
  const originalEnv = process.env;
  let envFilePath: string;
  let outputFilePath: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    const id = Math.random().toString(36).substring(2, 9);
    envFilePath = join(tmpdir(), `gh-env-test-${id}.txt`);
    outputFilePath = join(tmpdir(), `gh-output-test-${id}.txt`);
    writeFileSync(envFilePath, "");
    writeFileSync(outputFilePath, "");
    process.env.GITHUB_ENV = envFilePath;
    process.env.GITHUB_OUTPUT = outputFilePath;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(envFilePath)) {
      unlinkSync(envFilePath);
    }
    if (existsSync(outputFilePath)) {
      unlinkSync(outputFilePath);
    }
  });

  test("writes entries with trailing newline", () => {
    setGithubActionsOutputAndEnvVars({
      envVars: {
        VAR_ONE: "value1",
        VAR_TWO: "value2",
      },
      outputs: {
        outOne: "val1",
        outTwo: "val2",
      },
    });

    const envContent = readFileSync(envFilePath, "utf-8");
    const outputContent = readFileSync(outputFilePath, "utf-8");

    expect(envContent).toBe("VAR_ONE=value1\nVAR_TWO=value2\n");
    expect(outputContent).toBe("outOne=val1\noutTwo=val2\n");
  });

  test("multiple sequential calls terminate each line and do not concatenate keys", () => {
    setGithubActionsOutputAndEnvVars({
      envVars: {
        TRIGGER_VERSION: "1.0.0",
      },
      outputs: {
        needsPromotion: "false",
      },
    });

    setGithubActionsOutputAndEnvVars({
      envVars: {
        NEXT_VAR: "next",
      },
      outputs: {
        subsequentOutput: "hello",
      },
    });

    const envContent = readFileSync(envFilePath, "utf-8");
    const outputContent = readFileSync(outputFilePath, "utf-8");

    expect(envContent).toBe("TRIGGER_VERSION=1.0.0\nNEXT_VAR=next\n");
    expect(outputContent).toBe("needsPromotion=false\nsubsequentOutput=hello\n");
  });

  test("empty entries do not append trailing newline or modify file", () => {
    setGithubActionsOutputAndEnvVars({
      envVars: {},
      outputs: {},
    });

    expect(readFileSync(envFilePath, "utf-8")).toBe("");
    expect(readFileSync(outputFilePath, "utf-8")).toBe("");
  });

  test("does nothing if GITHUB_ENV or GITHUB_OUTPUT are not set", () => {
    delete process.env.GITHUB_ENV;
    delete process.env.GITHUB_OUTPUT;

    expect(() => {
      setGithubActionsOutputAndEnvVars({
        envVars: { FOO: "bar" },
        outputs: { BAZ: "qux" },
      });
    }).not.toThrow();

    expect(readFileSync(envFilePath, "utf-8")).toBe("");
    expect(readFileSync(outputFilePath, "utf-8")).toBe("");
  });
});
