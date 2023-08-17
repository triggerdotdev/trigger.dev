import { pathExists } from "./fileSystem";
import { getUserPackageManager } from "./getUserPkgManager";



describe(getUserPackageManager.name, () => {
  describe(`should use ${pathExists.name} to check for package manager artifacts`, () => {
    it.todo('should return "yarn" if yarn.lock exists');

    it.todo('should return "pnpm" if pnpm-lock.yaml exists');

    it.todo('should return "npm" if package-lock.json exists');

    it.todo('should return "npm" if npm-shrinkwrap.json exists');
  });
  
  describe(`if doesn't found a artifacts, should use ${process.env.npm_config_user_agent} to detect package manager`, () => {
    it.todo('should return "yarn" if process.env.npm_config_user_agent starts with "yarn"');

    it.todo('should return "pnpm" if process.env.npm_config_user_agent starts with "pnpm"');

    it.todo('if doesn\'t start with "yarn" or "pnpm", should return "npm"');

    it.todo('should return "npm" if process.env.npm_config_user_agent is not set');
  });
})