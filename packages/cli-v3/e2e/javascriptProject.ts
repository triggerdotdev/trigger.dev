import { PackageManager } from "../src/utilities/getUserPackageManager.js";
import { JavascriptProject } from "../src/utilities/javascriptProject.js";

export class E2EJavascriptProject extends JavascriptProject {
  constructor(
    projectPath: string,
    private overridenPackageManager: PackageManager
  ) {
    super(projectPath);
  }

  async getPackageManager(): Promise<PackageManager> {
    return Promise.resolve(this.overridenPackageManager);
  }
}
