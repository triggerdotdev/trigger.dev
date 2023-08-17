import { randomUUID } from "crypto";
import { pathExists } from "./fileSystem";
import { getUserPackageManager } from "./getUserPkgManager";
import { join } from "path";

jest.mock('path', () => ({
  join: jest.fn().mockImplementation((...paths: string[]) => paths.join('/')),
}))

jest.mock('./fileSystem', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
}));

describe(getUserPackageManager.name, () => {
  let path: string;

  beforeEach(() => {
    path = randomUUID();
  });

  afterEach(jest.clearAllMocks);

  describe(`should use ${pathExists.name} to check for package manager artifacts`, () => {
    it('should join the path with the artifact name', async () => {
      await getUserPackageManager(path);

      expect(join).toBeCalledWith(path, 'yarn.lock');
      expect(join).toBeCalledWith(path, 'pnpm-lock.yaml');
      expect(join).toBeCalledWith(path, 'package-lock.json');
    });

    it(`should call ${pathExists.name} with the path.join result`, async () => {
      const expected = randomUUID();

      (join as jest.Mock).mockReturnValue(expected);

      await getUserPackageManager(path);

      expect(pathExists).toBeCalledWith(expected);
    });

    it.todo('should return "yarn" if yarn.lock exists');

    it.todo('should return "pnpm" if pnpm-lock.yaml exists');

    it.todo('should return "npm" if package-lock.json exists');

    it.todo('should return "npm" if npm-shrinkwrap.json exists');
  });
  
  describe(`if doesn't found a artifacts, should use process.env.npm_config_user_agent to detect package manager`, () => {
    it.todo('should return "yarn" if process.env.npm_config_user_agent starts with "yarn"');

    it.todo('should return "pnpm" if process.env.npm_config_user_agent starts with "pnpm"');

    it.todo('if doesn\'t start with "yarn" or "pnpm", should return "npm"');

    it.todo('should return "npm" if process.env.npm_config_user_agent is not set');
  });
})