import { DeployInput, ListDeploysInput } from "../schemas.js";
import { toolsMetadata } from "../config.js";
import { ToolMeta } from "../types.js";
import { respondWithError, toolHandler } from "../utils.js";
import { McpContext } from "../context.js";
import { x } from "tinyexec";
import { getPackageJson, tryResolveTriggerPackageVersion } from "../../commands/update.js";
import { VERSION } from "../../version.js";
import { resolveSync as esmResolve } from "mlly";
import { fileURLToPath } from "node:url";
import stripAnsi from "strip-ansi";

export const deployTool = {
  name: toolsMetadata.deploy.name,
  title: toolsMetadata.deploy.title,
  description: toolsMetadata.deploy.description,
  inputSchema: DeployInput.shape,
  handler: toolHandler(DeployInput.shape, async (input, { ctx, createProgressTracker, _meta }) => {
    ctx.logger?.log("calling deploy", { input });

    if (ctx.options.devOnly) {
      return respondWithError(
        `This MCP server is only available for the dev environment. The deploy command is not allowed with the --dev-only flag.`
      );
    }

    const cwd = await ctx.getProjectDir({ cwd: input.configPath });

    if (!cwd.ok) {
      return respondWithError(cwd.error);
    }

    const auth = await ctx.getAuth();

    const args = ["deploy", "--env", input.environment, "--api-url", auth.auth.apiUrl];

    if (input.environment === "preview" && input.branch) {
      args.push("--branch", input.branch);
    }

    if (ctx.options.profile) {
      args.push("--profile", ctx.options.profile);
    }

    if (input.skipPromotion) {
      args.push("--skip-promotion");
    }

    if (input.skipSyncEnvVars) {
      args.push("--skip-sync-env-vars");
    }

    if (input.skipUpdateCheck) {
      args.push("--skip-update-check");
    }

    const [nodePath, cliPath] = await resolveCLIExec(ctx, cwd.cwd);

    ctx.logger?.log("deploy process args", {
      nodePath,
      cliPath,
      args,
      meta: _meta,
    });

    const progressTracker = createProgressTracker(100);
    await progressTracker.updateProgress(
      5,
      `Starting deploy to ${input.environment}${input.branch ? ` on branch ${input.branch}` : ""}`
    );

    const deployProcess = x(nodePath, [cliPath, ...args], {
      nodeOptions: {
        cwd: cwd.cwd,
        env: {
          TRIGGER_MCP_SERVER: "1",
        },
      },
    });

    const logs = [];

    for await (const line of deployProcess) {
      const lineWithoutAnsi = stripAnsi(line);

      const buildingVersion = lineWithoutAnsi.match(/Building version (\d+\.\d+)/);

      if (buildingVersion) {
        await progressTracker.incrementProgress(1, `Building version ${buildingVersion[1]}`);
      } else {
        await progressTracker.incrementProgress(1);
      }

      logs.push(stripAnsi(line));
    }

    await progressTracker.complete("Deploy complete");

    ctx.logger?.log("deploy deployProcess", {
      logs,
    });

    if (deployProcess.exitCode !== 0) {
      return respondWithError(logs.join("\n"));
    }

    return {
      content: [{ type: "text", text: logs.join("\n") }],
    };
  }),
};

export const listDeploysTool = {
  name: toolsMetadata.list_deploys.name,
  title: toolsMetadata.list_deploys.title,
  description: toolsMetadata.list_deploys.description,
  inputSchema: ListDeploysInput.shape,
  handler: toolHandler(ListDeploysInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling list_deploys", { input });

    if (ctx.options.devOnly) {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:deployments"],
      branch: input.branch,
    });

    const result = await apiClient.listDeployments(input);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }),
};

async function resolveCLIExec(context: McpContext, cwd?: string): Promise<[string, string]> {
  // Lets first try to get the version of the CLI package
  const installedCLI = await tryResolveTriggerCLIPath(context, cwd);

  if (installedCLI) {
    context.logger?.log("resolve_cli_exec installedCLI", { installedCLI });

    return [process.argv[0] ?? "node", installedCLI.path];
  }

  const sdkVersion = await tryResolveTriggerPackageVersion("@trigger.dev/sdk", cwd);

  if (!sdkVersion) {
    context.logger?.log("resolve_cli_exec no sdk version found", { cwd });

    return [process.argv[0] ?? "npx", process.argv[1] ?? "trigger.dev@latest"];
  }

  if (sdkVersion === VERSION) {
    context.logger?.log("resolve_cli_exec sdk version is the same as the current version", {
      sdkVersion,
    });

    if (typeof process.argv[0] === "string" && typeof process.argv[1] === "string") {
      return [process.argv[0], process.argv[1]];
    }

    return ["npx", "trigger.dev@latest"];
  }

  return ["npx", `trigger.dev@${sdkVersion}`];
}

async function tryResolveTriggerCLIPath(
  context: McpContext,
  basedir?: string
): Promise<
  | {
      path: string;
      version: string;
    }
  | undefined
> {
  try {
    const resolvedPathFileURI = esmResolve("trigger.dev", {
      url: basedir,
    });

    const resolvedPath = fileURLToPath(resolvedPathFileURI);

    context.logger?.log("resolve_cli_exec resolvedPathFileURI", { resolvedPathFileURI });

    const { packageJson } = await getPackageJson(resolvedPath, {
      test: (filePath) => {
        // We need to skip any type-marker files
        if (filePath.includes("dist/commonjs")) {
          return false;
        }

        if (filePath.includes("dist/esm")) {
          return false;
        }

        return true;
      },
    });

    if (packageJson.version) {
      context.logger?.log("resolve_cli_exec packageJson", { packageJson });

      return { path: resolvedPath, version: packageJson.version };
    }

    return;
  } catch (error) {
    context.logger?.log("resolve_cli_exec error", { error });
    return undefined;
  }
}
