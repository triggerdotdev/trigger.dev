import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tryCatch } from "@trigger.dev/core/utils";
import { ApiClient } from "@trigger.dev/core/v3";
import fs from "node:fs";
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

const MCP_CONFIG_DIR = ".trigger";
const MCP_CONFIG_FILE = "mcp.json";

type McpProjectConfig = {
  profile?: string;
};

function readMcpProjectConfig(projectDir: string): McpProjectConfig | undefined {
  try {
    const filePath = path.join(projectDir, MCP_CONFIG_DIR, MCP_CONFIG_FILE);
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as McpProjectConfig;
  } catch {
    return undefined;
  }
}

function writeMcpProjectConfig(projectDir: string, config: McpProjectConfig): void {
  const dir = path.join(projectDir, MCP_CONFIG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, MCP_CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
}

export type McpContextOptions = {
  projectRef?: string;
  fileLogger?: FileLogger;
  apiUrl?: string;
  profile?: string;
  devOnly?: boolean;
  readonly?: boolean;
};

export class McpContext {
  public readonly server: McpServer;
  public readonly options: McpContextOptions;
  private _profileLoaded: Promise<void> | undefined;
  private _resolveProfileLoaded: (() => void) | undefined;

  constructor(server: McpServer, options: McpContextOptions) {
    this.server = server;
    this.options = options;
    this._profileLoaded = new Promise((resolve) => {
      this._resolveProfileLoaded = resolve;
    });
  }

  get logger() {
    return this.options.fileLogger;
  }

  public async getAuth() {
    // Wait for project profile to be loaded before authenticating
    await this._profileLoaded;
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

  public switchProfile(profile: string, projectDir?: string) {
    this.options.profile = profile;

    // Persist to project-scoped config if we can resolve the project dir
    if (projectDir) {
      try {
        const existing = readMcpProjectConfig(projectDir) ?? {};
        writeMcpProjectConfig(projectDir, { ...existing, profile });
      } catch {
        // Non-fatal — profile still switched in memory
      }
    }
  }

  /**
   * Load the persisted profile from the project-scoped .trigger/mcp.json.
   * Overrides the default global profile with the project-scoped one.
   * Must be called once after initialization — tools wait for this before authenticating.
   */
  public async loadProjectProfile() {
    try {
      const cwd = await this.getCwd();
      if (!cwd) return;

      const config = readMcpProjectConfig(cwd);
      if (config?.profile) {
        this.options.profile = config.profile;
        this.logger?.log("Loaded project profile", { profile: config.profile, cwd });
      }
    } finally {
      this._resolveProfileLoaded?.();
    }
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
}
