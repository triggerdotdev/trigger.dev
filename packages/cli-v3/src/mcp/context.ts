import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tryCatch } from "@trigger.dev/core/utils";
import { ApiClient } from "@trigger.dev/core/v3";
import path from "node:path";
import { CliApiClient } from "../apiClient.js";
import { loadConfig } from "../config.js";
import { mcpAuth } from "./auth.js";
import {
  hasElicitationCapability,
  hasRootsCapability,
  hasSamplingCapability,
} from "./capabilities.js";
import { FileLogger } from "./logger.js";
import { fileURLToPath } from "node:url";

export type McpContextOptions = {
  projectRef?: string;
  fileLogger?: FileLogger;
  apiUrl?: string;
  profile?: string;
  devOnly?: boolean;
  envOnly?: string[];
  disableDeployment?: boolean;
  readonly?: boolean;
};

export class McpContext {
  public readonly server: McpServer;
  public readonly options: McpContextOptions;

  constructor(server: McpServer, options: McpContextOptions) {
    this.server = server;
    this.options = options;
  }

  get logger() {
    return this.options.fileLogger;
  }

  public async getAuth() {
    const auth = await mcpAuth({
      server: this.server,
      defaultApiUrl: this.options.apiUrl,
      profile: this.options.profile,
      context: this,
    });

    if (!auth.ok) {
      throw new Error(auth.error);
    }

    return auth;
  }

  public async getCliApiClient(branch?: string) {
    const auth = await this.getAuth();

    return new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken, branch);
  }

  public async getApiClient(options: {
    projectRef: string;
    environment: string;
    scopes: string[];
    branch?: string;
  }) {
    const cliApiClient = await this.getCliApiClient(options.branch);

    const jwt = await cliApiClient.getJWT(options.projectRef, options.environment, {
      claims: {
        scopes: options.scopes,
      },
    });

    if (!jwt.success) {
      throw new Error(
        `Could not get the authentication token for the project ${options.projectRef} in the ${options.environment} environment. Please try again.`
      );
    }

    return new ApiClient(cliApiClient.apiURL, jwt.data.token);
  }

  public async getCwd() {
    if (!this.hasRootsCapability) {
      return undefined;
    }

    const response = await this.server.server.listRoots();

    if (response.roots.length >= 1) {
      return response.roots[0]?.uri ? fileURLToPath(response.roots[0].uri) : undefined;
    }

    return undefined;
  }

  public async getProjectRef(options: { projectRef?: string; cwd?: string }) {
    if (options.projectRef) {
      return options.projectRef;
    }

    const projectDir = await this.getProjectDir({ cwd: options.cwd });

    if (!projectDir.ok) {
      throw new Error(projectDir.error);
    }

    const [_, config] = await tryCatch(loadConfig({ cwd: projectDir.cwd }));

    if (
      config?.configFile &&
      typeof config.project === "string" &&
      config.project.startsWith("proj_")
    ) {
      return config.project;
    }

    throw new Error("No project ref found. Please provide a projectRef.");
  }

  public async getProjectDir({ cwd }: { cwd?: string }) {
    // If cwd is a path to the actual trigger.config.ts file, then we should set the cwd to the directory of the file
    let $cwd = cwd ? (path.extname(cwd) !== "" ? path.dirname(cwd) : cwd) : undefined;

    function isRelativePath(filePath: string) {
      return !path.isAbsolute(filePath);
    }

    if (!cwd) {
      if (!this.hasRootsCapability) {
        return {
          ok: false,
          error:
            "The current MCP server does not support the roots capability, so please call the tool again with a projectRef or an absolute path as cwd parameter",
        };
      }

      $cwd = await this.getCwd();
    } else if (isRelativePath(cwd)) {
      if (!this.hasRootsCapability) {
        return {
          ok: false,
          error:
            "The current MCP server does not support the roots capability, so please call the tool again with a projectRef or an absolute path as cwd parameter",
        };
      }

      const resolvedCwd = await this.getCwd();

      if (!resolvedCwd) {
        return {
          ok: false,
          error: "No current working directory found. Please provide a projectRef or a cwd.",
        };
      }

      $cwd = path.resolve(resolvedCwd, cwd);
    }

    if (!$cwd) {
      return {
        ok: false,
        error: "No current working directory found. Please provide a projectRef or a cwd.",
      };
    }

    return {
      ok: true,
      cwd: $cwd,
    };
  }

  public async getDashboardUrl(path: string) {
    const auth = await this.getAuth();
    return `${auth.dashboardUrl}${path}`;
  }

  public get hasRootsCapability() {
    return hasRootsCapability(this.server);
  }

  public get hasSamplingCapability() {
    return hasSamplingCapability(this.server);
  }

  public get hasElicitationCapability() {
    return hasElicitationCapability(this.server);
  }

  public isEnvironmentAllowed(environment: string): boolean {
    // Normalize the environment name for comparison
    const normalizedEnv = environment.trim().toLowerCase();

    // If envOnly is specified, use that (devOnly is already converted to envOnly)
    if (this.options.envOnly && this.options.envOnly.length > 0) {
      // Note: envOnly is already normalized to lowercase in mcp.ts
      return this.options.envOnly.includes(normalizedEnv);
    }

    // If no restrictions, all environments are allowed
    return true;
  }

  public getAllowedEnvironments(): string {
    if (this.options.envOnly && this.options.envOnly.length > 0) {
      return this.options.envOnly.join(", ");
    }
    return "all environments";
  }
}
