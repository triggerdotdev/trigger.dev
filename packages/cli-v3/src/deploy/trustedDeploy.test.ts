import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { configurePreviewCommand } from "../commands/preview.js";
import { configurePromoteCommand } from "../commands/promote.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

async function withTempProject(run: (project: string) => Promise<void>) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const project = await mkdtemp(join(tmpdir(), "trusted-deploy-"));
  try {
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "trusted-deploy-test" }));
    await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(
      join(project, "trigger.config.ts"),
      'export default { project: "proj_test", maxDuration: 60, dirs: [] };\n'
    );
    process.chdir(project);
    await run(project);
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    await rm(project, { recursive: true, force: true });
  }
}

describe("trusted deployment CLI authentication", () => {
  const requests: { path: string; authorization?: string; body: unknown }[] = [];
  let apiUrl: string;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url?.startsWith("/token?")) {
      response.end(JSON.stringify({ value: "github-jwt" }));
    } else if (request.url?.endsWith("/archive") && body?.branch === "denied") {
      response.writeHead(403);
      response.end(JSON.stringify({ error: "Archive denied" }));
    } else if (request.url === "/api/v1/trusted-deploys/archive") {
      response.end(JSON.stringify({ success: true }));
    } else if (request.url === "/api/v1/trusted-deploys/promote") {
      response.end(JSON.stringify({ id: "dep_test", version: "20261109.1", shortCode: "abc" }));
    } else if (request.url === "/api/v1/projects/proj_test/branches/archive") {
      response.end(JSON.stringify({ branch: { id: "env_preview" } }));
    } else {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "Unexpected request" }));
    }
  });
  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    requests.length = 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  // Catches: explicit OIDC still using an environment API key or stored login.
  it("uses explicit credentials before automatic OIDC, but explicit OIDC overrides them", () => {
    expect(shouldUseGithubOidc("auto", "tr_prod_key", github)).toBe(false);
    expect(shouldUseGithubOidc("auto", "tr_pat_token", github)).toBe(false);
    expect(shouldUseGithubOidc("auto", undefined, github)).toBe(true);
    expect(shouldUseGithubOidc("oidc", "tr_prod_key", github)).toBe(true);
    expect(shouldUseGithubOidc("auto", undefined, {})).toBe(false);
  });

  // Catches: closed or merged PR events queueing a build instead of archiving through OIDC.
  it.each(["open", "closed", "merged"] as const)(
    "handles a %s Preview PR before invoking deployment",
    async (state) => {
      await withTempProject(async (project) => {
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
        for (const [name, value] of Object.entries({
          ...github,
          ACTIONS_ID_TOKEN_REQUEST_URL: `${apiUrl}/token`,
          TRIGGER_API_URL: apiUrl,
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
        await expect(result).resolves.toBeUndefined();
        expect(deployed).toBe(state === "open");
        expect(
          requests.filter((request) => request.path === "/api/v1/trusted-deploys/archive")
        ).toEqual(
          state === "open"
            ? []
            : [
                {
                  path: "/api/v1/trusted-deploys/archive",
                  authorization: "Bearer github-jwt",
                  body: { projectRef: "proj_test", env: "preview", branch: "feature" },
                },
              ]
        );
      });
    }
  );

  // Catches: archive requiring a PAT login despite an API key, or lifecycle commands ignoring explicit/automatic OIDC.
  it.each([
    {
      command: "archive",
      authMethod: "auto",
      accessToken: "tr_preview_sk_test",
      oidc: false,
      env: "preview",
    },
    { command: "archive", authMethod: "auto", accessToken: undefined, oidc: true, env: "preview" },
    {
      command: "archive",
      authMethod: "oidc",
      accessToken: "tr_prod_sk_test",
      oidc: true,
      env: "preview",
    },
    {
      command: "promote",
      authMethod: "oidc",
      accessToken: "tr_prod_sk_test",
      oidc: true,
      env: "preview",
    },
    {
      command: "promote",
      authMethod: "oidc",
      accessToken: "tr_preview_sk_test",
      oidc: true,
      env: undefined,
    },
  ])(
    "$command with $authMethod and token $accessToken",
    async ({ command, authMethod, accessToken, oidc, env }) => {
      await withTempProject(async () => {
        const exitCode = process.exitCode;
        for (const [name, value] of Object.entries({
          ...github,
          ACTIONS_ID_TOKEN_REQUEST_URL: `${apiUrl}/token`,
          TRIGGER_API_URL: apiUrl,
          TRIGGER_ACCESS_TOKEN: accessToken,
          TRIGGER_GITHUB_APP: "false",
        }))
          vi.stubEnv(name, value);
        const program = new Command();
        configurePreviewCommand(program);
        configurePromoteCommand(program);
        await program.parseAsync(
          [
            ...(command === "archive"
              ? ["preview", "archive"]
              : ["promote", "20261109.1", ...(env ? ["--env", env] : [])]),
            ...(env === "preview" ? ["--branch", "other-branch"] : []),
            "--auth-method",
            authMethod,
            "--skip-update-check",
            "--skip-telemetry",
          ],
          { from: "user" }
        );
        expect(process.exitCode).toBe(exitCode);
        const operation = requests.find((request) => request.path.startsWith("/api/"));
        expect(operation).toEqual({
          path: oidc
            ? `/api/v1/trusted-deploys/${command}`
            : "/api/v1/projects/proj_test/branches/archive",
          authorization: `Bearer ${oidc ? "github-jwt" : accessToken}`,
          body: {
            ...(oidc ? { projectRef: "proj_test" } : {}),
            env: env ?? "prod",
            ...(env === "preview" ? { branch: "other-branch" } : {}),
            ...(command === "promote" ? { version: "20261109.1" } : {}),
          },
        });
        expect(requests.filter((request) => request.path.startsWith("/token?"))).toHaveLength(
          oidc ? 1 : 0
        );
      });
    }
  );

  // Catches: failed API-key cleanup reporting success to CI instead of failing like OIDC cleanup.
  it.each(["token", "oidc"] as const)(
    "fails the archive command with %s auth when cleanup is denied",
    async (auth) => {
      await withTempProject(async () => {
        for (const [name, value] of Object.entries({
          ...github,
          ACTIONS_ID_TOKEN_REQUEST_URL: `${apiUrl}/token`,
          TRIGGER_API_URL: apiUrl,
          TRIGGER_ACCESS_TOKEN: auth === "token" ? "tr_preview_sk_test" : undefined,
          TRIGGER_GITHUB_APP: "false",
        }))
          vi.stubEnv(name, value);
        const program = new Command();
        configurePreviewCommand(program);
        await program.parseAsync(
          ["preview", "archive", "--branch", "denied", "--skip-update-check", "--skip-telemetry"],
          { from: "user" }
        );
        expect(process.exitCode).toBe(1);
      });
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
