import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DeployCommandOptions } from "../commands/deploy.js";
import {
  runTrustedDeploy,
  shouldUseGithubOidc,
  validateTrustedDeployOptions,
} from "./trustedDeploy.js";

const github = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

describe("trusted deployment CLI authentication", () => {
  // Catches: explicit OIDC still using an environment API key or stored login.
  it("uses explicit credentials before automatic OIDC, but explicit OIDC overrides them", () => {
    expect(shouldUseGithubOidc("auto", "tr_prod_key", github)).toBe(false);
    expect(shouldUseGithubOidc("auto", "tr_pat_token", github)).toBe(false);
    expect(shouldUseGithubOidc("auto", undefined, github)).toBe(true);
    expect(shouldUseGithubOidc("oidc", "tr_prod_key", github)).toBe(true);
    expect(shouldUseGithubOidc("auto", undefined, {})).toBe(false);
  });

  // Catches: closed or merged PR events queueing a new Preview build instead of rejecting unsupported cleanup.
  it.each(["open", "closed", "merged"] as const)(
    "handles a %s Preview PR before invoking deployment",
    async (state) => {
      const cwd = process.cwd();
      const project = await mkdtemp(join(tmpdir(), "trusted-deploy-pr-"));
      try {
        await writeFile(
          join(project, "package.json"),
          JSON.stringify({ name: "trusted-deploy-test" })
        );
        await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        await writeFile(
          join(project, "trigger.config.ts"),
          'export default { project: "proj_test", maxDuration: 60, dirs: [] };\n'
        );
        const eventPath = join(project, "event.json");
        await writeFile(
          eventPath,
          JSON.stringify({
            pull_request: {
              number: 123,
              state: state === "merged" ? "closed" : state,
              merged: state === "merged",
              head: { ref: "feature", sha: "a".repeat(40) },
            },
          })
        );
        process.chdir(project);
        for (const [name, value] of Object.entries({
          ...github,
          GITHUB_SHA: "a".repeat(40),
          GITHUB_REF: "refs/pull/123/merge",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          TRIGGER_GITHUB_APP: "false",
          TRIGGER_EXISTING_DEPLOYMENT_ID: undefined,
        }))
          vi.stubEnv(name, value);
        let deployed = false;
        const result = runTrustedDeploy(
          project,
          {
            env: "preview",
            apiUrl: "https://example.invalid",
          } as DeployCommandOptions,
          async () => {
            deployed = true;
          }
        );
        if (state === "open") await expect(result).resolves.toBeUndefined();
        else await expect(result).rejects.toThrow("OIDC cannot archive Preview branches");
        expect(deployed).toBe(state === "open");
      } finally {
        process.chdir(cwd);
        vi.unstubAllEnvs();
        await rm(project, { recursive: true, force: true });
      }
    }
  );

  // Catches: bundling locally or falling back to Depot before reaching the restricted submission path.
  it("rejects every build mode that can read or sync environment variables in the CLI", () => {
    const options = { localBundle: false, depotBuild: false, dryRun: false };
    expect(() => validateTrustedDeployOptions(options)).not.toThrow();
    for (const unsupported of [
      { localBuild: true },
      { forceLocalBuild: true },
      { depotBuild: true },
      { localBundle: true },
      { fromBundle: "/bundle" },
      { dryRun: true },
    ]) {
      expect(() => validateTrustedDeployOptions({ ...options, ...unsupported })).toThrow(
        "full build-server"
      );
    }
  });
});
