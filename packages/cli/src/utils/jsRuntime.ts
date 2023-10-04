import { Framework, getFramework } from "../frameworks";
import { PackageManager, getUserPackageManager } from "./getUserPkgManager";
import { Logger } from "./logger";
import { run as ncuRun } from "npm-check-updates";
import chalk from "chalk";
import fs from "fs/promises";
import pathModule from "path";

type SupportedRuntimeId = "node" | "deno";

abstract class JsRuntime {
  logger: Logger;
  projectRootPath: string;
  constructor(projectRootPath: string, logger: Logger) {
    this.logger = logger;
    this.projectRootPath = projectRootPath;
  }
  abstract checkForOutdatedPackages(): Promise<void>;
  abstract getUserPackageManager(): Promise<PackageManager | undefined>;
  abstract getFramework(): Promise<Framework | undefined>;
  abstract getEndpointId(): Promise<string | undefined>;
  static async getJsRuntime(projectRootPath: string, logger: Logger) {
    if (await NodeJsRuntime.isNodeJsRuntime(projectRootPath)) {
      return new NodeJsRuntime(projectRootPath, logger);
    } else if (await DenoRuntime.isDenoJsRuntime(projectRootPath)) {
      return new DenoRuntime(projectRootPath, logger);
    }
    throw new Error("Unsupported runtime");
  }
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

  get packageJsonPath(): string {
    return pathModule.join(this.projectRootPath, "package.json");
  }

  async checkForOutdatedPackages(): Promise<void> {
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
    console.log(chalk.bgYellow("Updates available for trigger.dev packages"));
    console.log(chalk.bgBlue("Run npx @trigger.dev/cli@latest update"));

    for (let dep in updates) {
      console.log(`${dep}  ${dependencies[dep]}  →  ${updates[dep]}`);
    }
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
    return pkgJson["trigger.dev"]?.endpointId;
  }
}

class DenoRuntime extends JsRuntime {
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

  async checkForOutdatedPackages() {
    // not implemented currently
  }
  async getUserPackageManager() {
    return undefined;
  }
  async getFramework() {
    // not implemented currently
    return undefined;
  }
  async getEndpointId() {
    const pkgJsonPath = pathModule.join(this.projectRootPath, "deno.json");
    const pkgBuffer = await fs.readFile(pkgJsonPath);
    const pkgJson = JSON.parse(pkgBuffer.toString());
    return pkgJson["trigger.dev"]?.endpointId;
  }
}
