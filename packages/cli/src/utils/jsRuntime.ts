import { Framework, getFramework } from "../frameworks";
import { PackageManager, getUserPackageManager } from "./getUserPkgManager";
import { Logger } from "./logger";
import { run as ncuRun } from "npm-check-updates";
import fs from "fs/promises";
import pathModule from "path";

export abstract class JsRuntime {
  logger: Logger;
  projectRootPath: string;
  constructor(projectRootPath: string, logger: Logger) {
    this.logger = logger;
    this.projectRootPath = projectRootPath;
  }
  abstract get id(): string;
  abstract checkForOutdatedPackages(): Promise<{ from: string; to: string } | undefined>;
  abstract getUserPackageManager(): Promise<PackageManager | undefined>;
  abstract getFramework(): Promise<Framework | undefined>;
  abstract getEndpointId(): Promise<string | undefined>;
}

export async function getJsRuntime(projectRootPath: string, logger: Logger): Promise<JsRuntime> {
  if (await NodeJsRuntime.isNodeJsRuntime(projectRootPath)) {
    return new NodeJsRuntime(projectRootPath, logger);
  } else if (await DenoRuntime.isDenoJsRuntime(projectRootPath)) {
    return new DenoRuntime(projectRootPath, logger);
  }
  throw new Error("Unsupported runtime");
}

class NodeJsRuntime extends JsRuntime {
  static async isNodeJsRuntime(projectRootPath: string): Promise<boolean> {
    try {
      await fs.stat(pathModule.join(projectRootPath, "package.json"));
      return true;
    } catch {
      return false;
    }
  }

  get id() {
    return "nodejs";
  }
  get packageJsonPath(): string {
    return pathModule.join(this.projectRootPath, "package.json");
  }

  async checkForOutdatedPackages(): Promise<{ from: string; to: string } | undefined> {
    const updates = (await ncuRun({
      packageFile: `${this.packageJsonPath}`,
      filter: "/trigger.dev/.+$/",
      upgrade: false,
    })) as {
      [key: string]: string;
    };

    if (typeof updates === "undefined" || Object.keys(updates).length === 0) {
      return;
    }

    const packageFile = await fs.readFile(this.packageJsonPath);
    const data = JSON.parse(Buffer.from(packageFile).toString("utf8"));
    const dependencies = data.dependencies;

    const hasUpdates = Object.keys(updates).length > 0;

    if (!hasUpdates) {
      return;
    }

    const firstDep = Object.keys(updates)[0];

    if (!firstDep) {
      return;
    }

    const from = dependencies[firstDep];
    const to = updates[firstDep];

    if (!to || !from) {
      return;
    }

    return { from, to };
  }

  async getUserPackageManager() {
    return getUserPackageManager(this.projectRootPath);
  }

  async getFramework() {
    const userPackageManager = await this.getUserPackageManager();
    return getFramework(this.projectRootPath, userPackageManager);
  }
  async getEndpointId() {
    const pkgJsonPath = pathModule.join(this.projectRootPath, "package.json");
    const pkgBuffer = await fs.readFile(pkgJsonPath);
    const pkgJson = JSON.parse(pkgBuffer.toString());
    const value = pkgJson["trigger.dev"]?.endpointId;
    if (!value || typeof value !== "string") return undefined;
    return value;
  }
}

class DenoRuntime extends JsRuntime {
  getDenoJsonPath(): Promise<string> {
    try {
      return fs
        .stat(pathModule.join(this.projectRootPath, "deno.json"))
        .then(() => pathModule.join(this.projectRootPath, "deno.json"));
    } catch {
      return fs
        .stat(pathModule.join(this.projectRootPath, "deno.jsonc"))
        .then(() => pathModule.join(this.projectRootPath, "deno.jsonc"));
    }
  }

  get id() {
    return "deno";
  }

  static async isDenoJsRuntime(projectRootPath: string): Promise<boolean> {
    try {
      try {
        await fs.stat(pathModule.join(projectRootPath, "deno.json"));
      } catch (e) {
        await fs.stat(pathModule.join(projectRootPath, "deno.jsonc"));
      }
      return true;
    } catch {
      return false;
    }
  }

  async checkForOutdatedPackages(): Promise<{ from: string; to: string } | undefined> {
    return;
  }
  async getUserPackageManager() {
    return undefined;
  }
  async getFramework() {
    // not implemented currently
    return undefined;
  }
  async getEndpointId() {
    const pkgJsonPath = await this.getDenoJsonPath();
    const pkgBuffer = await fs.readFile(pkgJsonPath);
    const pkgJson = JSON.parse(pkgBuffer.toString());
    return pkgJson["trigger.dev"]?.endpointId;
  }
}
